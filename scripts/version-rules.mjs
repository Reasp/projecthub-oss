// Единая версия приложений ProjectHub (TASK-193, decision-148). Чистый модуль без git и fs: правила версии, файлы с
// версией и признак «коммит с кодом». CLI — scripts/version.mjs.

/**
 * Файлы с версией. Источник — корневой package.json, остальные повторяют его. `count` — сколько первых полей
 * `"version"` в файле относятся к самому приложению: в package-lock.json это корень и `packages[""]`.
 * Android-приложение читает версию из корневого package.json при сборке (mobile/android/app/build.gradle).
 */
export const VERSION_FILES = [
  { path: 'package.json', count: 1 },
  { path: 'package-lock.json', count: 2 },
  { path: 'mobile/package.json', count: 1 },
  { path: 'deploy/relay/package.json', count: 1 },
  { path: 'resources/obsidian-plugin/manifest.json', count: 1 }
];

/** Строка, по которой check узнаёт, что build.gradle берёт версию из package.json, а не держит свою. */
export const GRADLE_FILE = 'mobile/android/app/build.gradle';
export const GRADLE_MARKER = 'versionName phVersion';

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const FIELD_RE = /("version"\s*:\s*")([^"]*)(")/g;

export function parseVersion(version) {
  const m = VERSION_RE.exec(String(version ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Следующая версия: третье число + 1. */
export function bumpPatch(version) {
  const v = parseVersion(version);
  if (!v) throw new Error(`Версия «${version}» не вида X.Y.Z`);
  return `${v[0]}.${v[1]}.${v[2] + 1}`;
}

/** <0, 0, >0 как у сортировки. Невалидная версия меньше любой валидной. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** versionCode Android: растёт вместе с версией. Та же формула — в build.gradle. */
export function androidVersionCode(version) {
  const v = parseVersion(version);
  if (!v) throw new Error(`Версия «${version}» не вида X.Y.Z`);
  return v[0] * 1_000_000 + v[1] * 1_000 + v[2];
}

/** Значения первых `count` полей `"version"`. */
export function readVersions(text, count) {
  return Array.from(String(text).matchAll(FIELD_RE), (m) => m[2]).slice(0, count);
}

/** Меняет первые `count` полей `"version"`; остальной текст, отступы и переводы строк не трогает. */
export function setVersion(text, version, count) {
  let seen = 0;
  return String(text).replace(FIELD_RE, (all, open, _old, close) => (seen++ < count ? `${open}${version}${close}` : all));
}

/** Расхождения версий: `texts` — содержимое файлов по пути. Пустой список — версии согласованы. */
export function checkVersionTexts(texts) {
  const errors = [];
  const root = readVersions(texts['package.json'] ?? '', 1)[0];
  if (!parseVersion(root)) return [`package.json: версия «${root ?? ''}» не вида X.Y.Z`];
  for (const file of VERSION_FILES) {
    const text = texts[file.path];
    if (text === undefined) {
      errors.push(`${file.path}: файла нет`);
      continue;
    }
    const found = readVersions(text, file.count);
    if (found.length < file.count) errors.push(`${file.path}: нет поля "version"`);
    for (const v of found) if (v !== root) errors.push(`${file.path}: ${v}, а в package.json ${root}`);
  }
  const gradle = texts[GRADLE_FILE];
  if (gradle !== undefined && !gradle.includes(GRADLE_MARKER)) {
    errors.push(`${GRADLE_FILE}: versionName должен браться из package.json (${GRADLE_MARKER})`);
  }
  return errors;
}

/** Не код приложений: документация, задачи, индекс RAG, тесты, настройки агентов и CI. Всё остальное — код. */
const NON_CODE_PREFIXES = ['backlog/', '.rag-index/', 'tests/', 'pitch/', '.claude/', '.agents/', '.codex/', '.github/', '.projecthub/'];
const NON_CODE_FILES = new Set([
  'CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  'infra-dev.md',
  'LICENSE',
  '.gitignore',
  '.gitnexusignore',
  '.mcp.json',
  'infra.config.json',
  'tsconfig.node.tsbuildinfo',
  'eslint.config.js',
  'vitest.config.ts'
]);

export function isCodePath(file) {
  const p = String(file).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p) return false;
  if (NON_CODE_FILES.has(p) || NON_CODE_PREFIXES.some((prefix) => p.startsWith(prefix))) return false;
  return !p.toLowerCase().endsWith('.md');
}
