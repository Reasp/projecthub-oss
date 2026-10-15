// Сквозные правила документации Backlog.md (правило 14 infra-dev.md): раздел дерева документации,
// перекрёстные ссылки [[id]] и ссылки на заголовок [[id#Заголовок]]. Чистые функции без обращения
// к диску — их вызывает scripts/validate-docs.mjs. Правила пришли из ProjectHub (decision-68 и
// decision-69 там): правки вносить сначала в ProjectHub, затем переносить сюда.

/** Корни документации; раздел документа — поле `section` или вложенная папка внутри корня. */
export const DOC_ROOTS = ['backlog/docs', 'backlog/decisions'];

/**
 * Ключ заголовка для якоря ссылки: нижний регистр, всё кроме букв и цифр — дефис. Поэтому
 * `#Decision`, `#decision`, `#Принятое решение` и `#принятое-решение` находят свой заголовок.
 */
export function headingAnchorKey(text) {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** Ошибка формата поля `section` или null. Отсутствие поля ошибкой не является. */
export function sectionFieldError(section) {
  if (section === undefined || section === null) return null;
  if (typeof section !== 'string' || !section.trim()) {
    return 'Frontmatter, поле "section": ожидается непустая строка в кавычках, например "Архитектура/RAG"';
  }
  return null;
}

/** Документ лежит во вложенной папке корня документации — папка тоже считается разделом. */
export function isInSubfolder(relPath) {
  const docRoot = DOC_ROOTS.find((root) => relPath.startsWith(`${root}/`));
  return docRoot ? relPath.slice(docRoot.length + 1).includes('/') : false;
}

/**
 * Ссылки и заголовки тела документа. Ссылки внутри блоков кода и строчного кода — примеры,
 * а не ссылки; заголовки внутри блоков кода заголовками не считаются.
 */
export function extractDocRefs(body) {
  const withoutFences = body.replace(/```[\s\S]*?```/g, '');
  const prose = withoutFences.replace(/`[^`\n]*`/g, '');
  const matches = [...prose.matchAll(/\[\[\s*((?:decision|doc)-\d+)\s*(?:#([^\]|\n]*))?(?:\|[^\]\n]*)?\]\]/gi)];
  return {
    refs: [...new Set(matches.map((m) => m[1].toLowerCase()))],
    anchors: matches.filter((m) => m[2] && m[2].trim()).map((m) => ({ id: m[1].toLowerCase(), anchor: m[2].trim() })),
    headings: new Set([...withoutFences.matchAll(/^#{1,6}\s+(.*)$/gm)].map((m) => headingAnchorKey(m[1]))),
  };
}

/** Запись документа для сквозной проверки: `data` — разобранный frontmatter, `body` — текст без него. */
export function buildDocEntry(relPath, data, body) {
  const hasSectionField = typeof data.section === 'string' && data.section.trim() !== '';
  return {
    relPath,
    id: typeof data.id === 'string' ? data.id.trim().toLowerCase() : '',
    hasSection: hasSectionField || isInSubfolder(relPath),
    ...extractDocRefs(body),
  };
}

/**
 * Сквозная проверка набора документов и решений. Возвращает Map «путь → ошибки» только для
 * файлов с ошибками. Раздел обязателен, только если проект разделами пользуется: пока ни у
 * одного документа раздела нет, проверка молчит.
 */
export function crossCheckDocs(entries) {
  const knownIds = new Set(entries.map((doc) => doc.id).filter(Boolean));
  const headingsById = new Map(entries.filter((doc) => doc.id).map((doc) => [doc.id, doc.headings]));
  const usesSections = entries.some((doc) => doc.hasSection);
  const result = new Map();
  for (const doc of entries) {
    const errors = [];
    if (usesSections && !doc.hasSection) {
      errors.push(
        'Документ без раздела: добавьте во frontmatter поле section: "Раздел/Подраздел" ' +
          '(Backlog.md CLI стирает его при `doc update` — после обновления документа верните поле)',
      );
    }
    for (const ref of doc.refs) {
      if (!knownIds.has(ref)) errors.push(`Ссылка [[${ref}]] ведёт на несуществующий документ или решение`);
    }
    for (const { id, anchor } of doc.anchors) {
      const headings = headingsById.get(id);
      if (headings && !headings.has(headingAnchorKey(anchor))) {
        errors.push(`Ссылка [[${id}#${anchor}]]: в документе ${id} нет заголовка «${anchor}»`);
      }
    }
    if (errors.length > 0) result.set(doc.relPath, errors);
  }
  return result;
}
