import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { PROJECT_ROOT } from './config.mjs';
import { validateMemoryDir } from './memory-rules.mjs';
import { DOC_ROOTS, buildDocEntry, crossCheckDocs, sectionFieldError } from './doc-rules.mjs';

// Линтер документации Backlog.md (правило 14 infra-dev.md). Запускается из `npm run lint:docs`
// и из pre-commit хука. Проверяет:
//   1. YAML frontmatter есть, закрыт и содержит обязательные поля (id, title) — файлы без
//      doc-N/decision-N не видит веб-интерфейс Backlog.md (создавать только через CLI/MCP);
//   2. значения frontmatter — строки: незакавыченная дата `2026-09-03` (в том числе в списках
//      tags/labels) парсится YAML как объект Date, и потребители frontmatter падают на нём;
//   3. картинки — стандартный `![alt](src)` в одну строку, локальные файлы существуют, сырые
//      многострочные <img> внутри таблиц запрещены (рвут разметку);
//   4. раздел дерева документации (`section` или вложенная папка) — у всех документов и решений,
//      если им пользуется хотя бы один; ссылки `[[decision-N]]`/`[[doc-N]]` ведут на существующий
//      документ, якорь `[[id#Заголовок]]` есть в документе (scripts/doc-rules.mjs).
//
// Документация (полный набор проверок): backlog/docs, backlog/decisions.
// Задачи и milestones: только frontmatter.
const FRONTMATTER_ONLY_ROOTS = ['backlog/tasks', 'backlog/milestones'];
// Проектные роли агентов ProjectHub (.projecthub/roles): frontmatter-only, свой набор обязательных полей.
const ROLE_ROOTS = [{ path: '.projecthub/roles', requiredFields: ['slug', 'name'] }];
const ROOT = PROJECT_ROOT;

let hasErrors = false;
let totalFilesChecked = 0;
let totalImagesChecked = 0;
let totalFrontmatterFieldsChecked = 0;
// Документы и решения для сквозных проверок после обхода (scripts/doc-rules.mjs).
const docIndex = [];

function collectTypedValueErrors(value, keyPath, errors) {
  if (value instanceof Date) {
    const iso = isNaN(value.getTime()) ? 'invalid date' : value.toISOString().slice(0, 10);
    errors.push(
      `Frontmatter, поле "${keyPath}": незакавыченная дата (YAML распарсил как Date → ${iso}). ` +
        `Запишите строкой в кавычках: "${iso}" (правило 14)`,
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectTypedValueErrors(item, `${keyPath}[${i}]`, errors));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectTypedValueErrors(v, keyPath ? `${keyPath}.${k}` : k, errors);
    return;
  }
  totalFrontmatterFieldsChecked++;
}

function validateMarkdownFile(relPath, { frontmatterOnly = false, requiredFields = ['id', 'title'] } = {}) {
  const fullPath = path.join(ROOT, relPath);
  const content = fs.readFileSync(fullPath, 'utf-8');
  totalFilesChecked++;

  const errors = [];
  const warnings = [];

  if (!content.startsWith('---')) {
    errors.push('Отсутствует YAML Frontmatter в начале файла (должен начинаться с "---"). Документы создаются только через `backlog doc create` / MCP document_create');
  } else {
    const endMatch = content.indexOf('\n---', 3);
    if (endMatch === -1) {
      errors.push('YAML Frontmatter не закрыт (отсутствует закрывающий "---")');
    } else {
      const frontmatter = content.substring(3, endMatch);
      for (const field of requiredFields) {
        if (!frontmatter.includes(`${field}:`)) errors.push(`Отсутствует поле "${field}" во frontmatter`);
      }
      try {
        const { data, content: body } = matter(content);
        collectTypedValueErrors(data, '', errors);
        if (!frontmatterOnly) {
          const sectionError = sectionFieldError(data.section);
          if (sectionError) errors.push(sectionError);
          docIndex.push(buildDocEntry(relPath, data, body));
        }
      } catch (e) {
        errors.push(`Frontmatter не парсится как YAML: ${e.message}`);
      }
    }
  }

  if (frontmatterOnly) {
    reportFileResult(relPath, errors, warnings);
    return;
  }

  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    const trimmed = line.trim();

    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      if (/<img\b[^>]*$/i.test(trimmed)) {
        errors.push(`Строка ${lineNum}: незакрытый HTML-тег <img> в строке таблицы (разрыв строки ломает Markdown-таблицу)`);
      }
      if (/<img\b/i.test(trimmed) && !/!\[.*?\]\(.*?\)/.test(trimmed)) {
        warnings.push(`Строка ${lineNum}: сырой HTML-тег <img> в таблице. Рекомендуется стандартный синтаксис ![alt](src)`);
      }
    }

    for (const match of line.matchAll(/!\[(.*?)\]\((.*?)\)/g)) {
      totalImagesChecked++;
      const alt = match[1];
      const src = match[2];

      if (!src || !src.trim()) {
        errors.push(`Строка ${lineNum}: пустой путь к изображению с описанием "${alt}"`);
      } else if (src.startsWith('data:image/')) {
        if (!src.includes(';base64,')) {
          errors.push(`Строка ${lineNum}: некорректный data URI для изображения "${alt}"`);
        }
      } else if (!src.startsWith('http://') && !src.startsWith('https://') && !src.startsWith('file://')) {
        const resolvedPath = path.resolve(path.dirname(fullPath), src);
        if (!fs.existsSync(resolvedPath)) {
          errors.push(`Строка ${lineNum}: локальный файл изображения не найден: "${src}" (ожидался по пути ${resolvedPath})`);
        }
      }
    }
  });

  reportFileResult(relPath, errors, warnings);
}

function reportFileResult(relPath, errors, warnings) {
  if (errors.length > 0) {
    hasErrors = true;
    console.error(`\n❌ Ошибки в [${relPath}]:`);
    errors.forEach((err) => console.error(`   • ${err}`));
  }
  if (warnings.length > 0) {
    console.warn(`\n⚠️  Предупреждения в [${relPath}]:`);
    warnings.forEach((warn) => console.warn(`   • ${warn}`));
  }
  if (errors.length === 0 && warnings.length === 0 && process.argv.includes('--verbose')) {
    console.log(`✅ [${relPath}] — формат корректен`);
  }
}

function walkMarkdown(root, options) {
  const absRoot = path.join(ROOT, root);
  if (!fs.existsSync(absRoot)) return;
  for (const entry of fs.readdirSync(absRoot, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const full = path.join(entry.parentPath ?? entry.path, entry.name);
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      validateMarkdownFile(rel, options);
    }
  }
}

for (const docRoot of DOC_ROOTS) walkMarkdown(docRoot, {});
for (const fmRoot of FRONTMATTER_ONLY_ROOTS) walkMarkdown(fmRoot, { frontmatterOnly: true });
for (const roleRoot of ROLE_ROOTS) walkMarkdown(roleRoot.path, { frontmatterOnly: true, requiredFields: roleRoot.requiredFields });
// Сквозные проверки: раздел у каждого документа, ссылки [[id]] и якоря [[id#Заголовок]].
for (const [relPath, errors] of crossCheckDocs(docIndex)) reportFileResult(relPath, errors, []);
// Память проекта backlog/memory: формат факта, секреты, соответствие индекса MEMORY.md файлам.
for (const [relPath, errors] of validateMemoryDir(ROOT)) {
  totalFilesChecked++;
  reportFileResult(relPath, errors, []);
}

console.log(
  `Документация: проверено файлов — ${totalFilesChecked}, полей frontmatter — ${totalFrontmatterFieldsChecked}, изображений — ${totalImagesChecked}.`,
);

if (hasErrors) {
  console.error('\n🚨 Валидация документации завершилась с ошибками. Исправьте формат перед коммитом (правило 14 infra-dev.md).');
  process.exit(1);
} else {
  console.log('✓ Frontmatter, даты, изображения, разделы и ссылки документации в порядке.');
}
