#!/usr/bin/env node
// Синхронизация правил агентов: infra-dev.md → CLAUDE.md / GEMINI.md / AGENTS.md (секцией между маркерами)
// и → .agents/rules/infra-dev.md (целиком, для Google Antigravity). Паттерн условной разметки и проверки
// `--check --staged` пришли из встроенного шаблона ProjectHub (doc-13 там) и WorldSim (TASK-400 там).
//
//   npm run sync-rules                 перегенерировать файлы правил;
//   npm run sync-rules -- --check      только сверить рабочую копию (код выхода 1 — расхождение);
//   npm run sync-rules -- --check --staged   сверить версии из индекса git — так зовёт pre-commit:
//                                      соседняя сессия может держать в рабочей копии недописанную правку.
//
// Условная разметка infra-dev.md:
//   строка, оканчивающаяся на `<!-- if:имя -->`           — остаётся только при включённом условии;
//   блок `<!-- if:имя -->` … `<!-- endif -->` на своих строках — то же для нескольких строк (без вложенности);
//   `{{infraDir}}`                                          — путь к инфраструктуре от корня проекта.
// Имя условия — фича из infra.config.json (`lightrag`, `computerUse`, `playwright`, …), `subfolder`
// (инфраструктура лежит в подпапке проекта) или набор правил без кода: `lang-ru`, `windows`,
// `data-driven`, `code-ts`. Наборы включены все, пока в infra.config.json нет массива `ruleSets`
// с явным перечнем. Номера правил при вырезании блока не пересчитываются — ссылки «правило N» в
// тексте остаются верными, пропуск номера допустим.
//
// Скиллы: `.claude/skills/<имя>/SKILL.md` и `.agents/skills/<имя>/SKILL.md` сверяются (без учёта CRLF);
// расхождение или скилл только на одной стороне — предупреждение (Antigravity не читает .claude/skills).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG, FEATURES, INFRA_ROOT, PROJECT_ROOT } from './config.mjs';

export const SOURCE_FILE = 'infra-dev.md';
// AGENTS.md (не AGENT.md) — так называют дженерик-файл правил и Backlog.md
// (`backlog init --agent-instructions agents`), и GitNexus (`gitnexus analyze`),
// так что infra-dev-секция окажется в том же файле, а не в отдельном третьем.
export const MERGED_TARGETS = ['CLAUDE.md', 'GEMINI.md', 'AGENTS.md'];
// Google Antigravity читает workspace rules не только из корневых GEMINI.md/AGENTS.md,
// но и из отдельной папки `.agents/rules/` (`.agent/rules/` — старое имя, новых файлов там не пишем).
// Формат — обычный Markdown без фронтматтера, поэтому пишем файл целиком, без секций.
export const ANTIGRAVITY_RULES_TARGET = '.agents/rules/infra-dev.md';
export const START = '<!-- infra-dev:start (сгенерировано из infra-dev.md, правь его, не эту секцию) -->';
export const END = '<!-- infra-dev:end -->';
export const DEFAULT_RULE_SETS = ['lang-ru', 'windows', 'data-driven', 'code-ts'];

const BLOCK_IF = /^\s*<!--\s*if:([\w.-]+)\s*-->\s*$/;
const BLOCK_END = /^\s*<!--\s*endif\s*-->\s*$/;
const INLINE_IF = /\s*<!--\s*if:([\w.-]+)\s*-->\s*$/;

/** Предикат «условие включено» по фичам, наборам правил и режиму подпапки. */
export function conditionResolver({ features = {}, ruleSets = null, subfolder = false } = {}) {
  return (name) => {
    if (name === 'subfolder') return subfolder;
    if (Object.hasOwn(features, name)) return Boolean(features[name]);
    return Array.isArray(ruleSets) ? ruleSets.includes(name) : true;
  };
}

/** Текст правил после вырезания выключенных условий и подстановки {{infraDir}}. Чистая функция. */
export function renderRules(text, { isEnabled, infraDir = '.' }) {
  const out = [];
  let open = null;
  const lines = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');
  lines.forEach((rawLine, i) => {
    let line = rawLine;
    const block = BLOCK_IF.exec(line);
    if (block) {
      if (open) {
        throw new Error(
          `${SOURCE_FILE}:${i + 1}: вложенный <!-- if:${block[1]} --> внутри <!-- if:${open.name} --> (строка ${open.line}) не поддерживается`,
        );
      }
      open = { name: block[1], enabled: isEnabled(block[1]), line: i + 1 };
      return;
    }
    if (BLOCK_END.test(line)) {
      if (!open) throw new Error(`${SOURCE_FILE}:${i + 1}: <!-- endif --> без открывающего <!-- if:… -->`);
      open = null;
      return;
    }
    if (open && !open.enabled) return;
    const inline = INLINE_IF.exec(line);
    if (inline) {
      if (!isEnabled(inline[1])) return;
      line = line.slice(0, inline.index);
    }
    out.push(line.replaceAll('{{infraDir}}', infraDir));
  });
  if (open) throw new Error(`${SOURCE_FILE}: блок <!-- if:${open.name} --> (строка ${open.line}) не закрыт <!-- endif -->`);
  // Вырезанный блок оставляет две пустые строки подряд — схлопываем, чтобы diff целей был чистым.
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Файл цели с заменённой (или добавленной) секцией правил. */
export function mergeSection(current, block) {
  const startIdx = current.indexOf(START);
  const endIdx = current.indexOf(END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return current.slice(0, startIdx) + block + current.slice(endIdx + END.length);
  }
  const sep = current.endsWith('\n') ? '\n' : '\n\n';
  return `${current}${sep}${block}\n`;
}

/**
 * Нормализация для сравнения: BOM, CRLF и счётчики GitNexus («N symbols, N relationships…»), которые
 * `gitnexus analyze` переписывает в своей секции CLAUDE.md/AGENTS.md после каждого коммита.
 */
export function normalizeForCompare(text) {
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\(\d+ symbols, \d+ relationships, \d+ execution flows\)/g, '(N symbols, N relationships, N execution flows)')
    .trimEnd();
}

/** Расхождения зеркала скиллов между .claude/skills и .agents/skills — список сообщений. */
export function skillsDrift(root) {
  const claudeDir = path.join(root, '.claude', 'skills');
  const agentsDir = path.join(root, '.agents', 'skills');
  const names = (dir) =>
    fs.existsSync(dir)
      ? fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
          .map((e) => e.name)
      : [];
  const claude = new Set(names(claudeDir));
  const agents = new Set(names(agentsDir));
  const messages = [];
  const clean = (p) => fs.readFileSync(p, 'utf-8').replace(/^﻿/, '').replace(/\r\n/g, '\n').trimEnd();
  for (const name of [...claude].sort()) {
    if (!agents.has(name)) {
      messages.push(`скилл ${name} есть только в .claude/skills — Antigravity его не видит (скопируй в .agents/skills/${name}/)`);
    } else if (clean(path.join(claudeDir, name, 'SKILL.md')) !== clean(path.join(agentsDir, name, 'SKILL.md'))) {
      messages.push(`скилл ${name}: .claude/skills и .agents/skills расходятся — сверь и обнови копию`);
    }
  }
  for (const name of [...agents].sort()) {
    if (!claude.has(name)) messages.push(`скилл ${name} есть только в .agents/skills — Claude Code его не видит`);
  }
  return messages;
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function readWorking(rel) {
  const full = path.join(PROJECT_ROOT, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf-8') : null;
}

function readStaged(rel) {
  try {
    return execFileSync('git', ['show', `:./${toPosix(rel)}`], {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const staged = args.includes('--staged');
  const read = staged ? readStaged : readWorking;

  const sourceRel = toPosix(path.relative(PROJECT_ROOT, path.join(INFRA_ROOT, SOURCE_FILE)));
  const sourceText = read(sourceRel);
  if (sourceText === null) {
    console.error(`нет источника правил: ${sourceRel}${staged ? ' (в индексе git)' : ''}`);
    process.exit(1);
  }

  const subfolder = path.resolve(PROJECT_ROOT) !== path.resolve(INFRA_ROOT);
  const infraDir = subfolder ? toPosix(path.relative(PROJECT_ROOT, INFRA_ROOT)) : '.';
  const body = renderRules(sourceText, {
    isEnabled: conditionResolver({ features: FEATURES, ruleSets: CONFIG.ruleSets ?? null, subfolder }),
    infraDir,
  });
  const block = `${START}\n\n${body}\n\n${END}`;

  const plan = [
    ...MERGED_TARGETS.map((target) => ({
      target,
      expected: (current) => (current === null ? `# ${target}\n\n${block}\n` : mergeSection(current, block)),
    })),
    { target: ANTIGRAVITY_RULES_TARGET, expected: () => `${body}\n` },
  ];

  let drift = false;
  for (const { target, expected } of plan) {
    const current = read(target);
    const next = expected(current);
    const same = current !== null && normalizeForCompare(current) === normalizeForCompare(next);
    if (check) {
      if (same) {
        console.log(`совпадает: ${target}`);
      } else {
        console.error(current === null ? `нет файла: ${target}` : `устарел относительно ${SOURCE_FILE}: ${target}`);
        drift = true;
      }
      continue;
    }
    if (same) {
      console.log(`без изменений: ${target}`);
      continue;
    }
    const full = path.join(PROJECT_ROOT, target);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, next);
    console.log(`${current === null ? 'создан' : 'обновлён'}: ${target}`);
  }

  for (const message of skillsDrift(PROJECT_ROOT)) console.warn(`предупреждение: ${message}`);

  if (check && drift) {
    console.error('Правила агентов рассинхронизированы: выполните npm run sync-rules и добавьте результат в коммит.');
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
