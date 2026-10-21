/**
 * Правила отбора файлов `gitnexus analyze` (GitNexus 1.6.9, `config/ignore-service.js` и
 * `core/ingestion/filesystem-walker.js`), повторённые для предпросмотра области индексации (TASK-176).
 * Предпросмотр обязан считать тем же правилом, что сам индексатор, иначе число файлов в окне настроек
 * разойдётся с индексом. Поэтому списки скопированы как есть, включая учёт регистра у встроенного
 * списка каталогов. При обновлении GitNexus сверять с его `ignore-service.js` (см. decision-131).
 *
 * Чистый модуль без Electron и без чтения диска (правило 17): на вход — тексты `.gitignore`/`.gitnexusignore`.
 */
import ignore, { type Ignore } from 'ignore';

/** Встроенный список каталогов GitNexus. Сравнивается с сегментом пути с учётом регистра. */
export const GITNEXUS_DEFAULT_IGNORE_DIRS: ReadonlySet<string> = new Set([
  '.git', '.svn', '.hg', '.bzr',
  '.idea', '.vscode', '.vs', '.eclipse', '.settings', '.DS_Store', 'Thumbs.db',
  'node_modules', 'bower_components', 'jspm_packages', 'vendor', 'third_party', '3rdparty',
  'venv', '.venv', 'env', '.env', '__pycache__', '.pytest_cache', '.mypy_cache', 'site-packages', '.tox',
  'eggs', '.eggs', 'lib64', 'parts', 'sdist', 'wheels',
  'dist', 'build', 'out', 'output', 'bin', 'obj', 'target', '.next', '.nuxt', '.output', '.vercel', '.netlify',
  '.serverless', '_build', 'public/build', '.parcel-cache', '.turbo', '.svelte-kit',
  'coverage', '.nyc_output', 'htmlcov', '.coverage', '__tests__', '__mocks__', '.jest',
  'logs', 'log', 'tmp', 'temp', 'cache', '.cache', '.tmp', '.temp',
  '.generated', 'generated', 'auto-generated', 'monaco-workers', '.terraform',
  '.husky', '.github', '.circleci', '.gitlab', 'fixtures', 'snapshots', '__snapshots__'
]);

const IGNORED_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp', '.tiff', '.tif', '.psd', '.ai', '.sketch', '.fig', '.xd',
  '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2', '.xz', '.tgz',
  '.exe', '.dll', '.so', '.dylib', '.a', '.lib', '.o', '.obj', '.class', '.jar', '.war', '.ear', '.pyc', '.pyo', '.pyd',
  '.beam', '.wasm', '.node',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
  '.mp4', '.mp3', '.wav', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.ogg', '.webm', '.flac', '.aac', '.m4a',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.db', '.sqlite', '.sqlite3', '.mdb', '.accdb',
  '.min.js', '.min.css', '.bundle.js', '.chunk.js', '.map', '.lock',
  '.pem', '.key', '.crt', '.cer', '.p12', '.pfx',
  '.csv', '.tsv', '.parquet', '.avro', '.feather', '.npy', '.npz', '.pkl', '.pickle', '.h5', '.hdf5',
  '.bin', '.dat', '.data', '.raw', '.iso', '.img', '.dmg'
]);

const IGNORED_FILES: ReadonlySet<string> = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock', 'Gemfile.lock', 'poetry.lock', 'Cargo.lock', 'go.sum',
  '.gitignore', '.gitattributes', '.npmrc', '.yarnrc', '.editorconfig', '.prettierrc', '.prettierignore', '.eslintignore',
  '.dockerignore', 'Thumbs.db', '.DS_Store', 'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'CHANGELOG.md', 'CHANGELOG',
  'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md', '.env', '.env.local', '.env.development', '.env.production',
  '.env.test', '.env.example'
]);

/** Предел размера файла по умолчанию (`--max-file-size`, 512 КБ); больше — файл пропускается. */
export const GITNEXUS_DEFAULT_MAX_FILE_BYTES = 512 * 1024;

/** Встроенные правила GitNexus для пути файла (`shouldIgnorePath`). Путь — относительный, через `/`. */
export function gitnexusHardcodedIgnore(rel: string): boolean {
  const parts = rel.split('/');
  const fileName = parts[parts.length - 1];
  const lower = fileName.toLowerCase();
  if (/(^|\/)storage\/framework\/views(\/|$)/.test(rel.toLowerCase())) return true;
  if (parts.some((part) => GITNEXUS_DEFAULT_IGNORE_DIRS.has(part))) return true;
  if (IGNORED_FILES.has(fileName) || IGNORED_FILES.has(lower)) return true;
  const last = lower.lastIndexOf('.');
  if (last !== -1) {
    if (IGNORED_EXTENSIONS.has(lower.slice(last))) return true;
    const prev = lower.lastIndexOf('.', last - 1);
    if (prev !== -1 && IGNORED_EXTENSIONS.has(lower.slice(prev))) return true;
  }
  return lower.includes('.bundle.') || lower.includes('.chunk.') || lower.includes('.generated.') || lower.endsWith('.d.ts');
}

/** Есть ли явное `!правило` для пути или его предка (`hasExplicitUnignore`). */
function hasExplicitUnignore(ig: Ignore, rel: string): boolean {
  if (ig.test(rel).unignored || ig.test(`${rel}/`).unignored) return true;
  const parts = rel.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    if (ig.test(`${parts.slice(0, i).join('/')}/`).unignored) return true;
  }
  return false;
}

export interface GitNexusFilter {
  /** Файл не попадёт в индекс (`ignored`). */
  ignoresFile(rel: string): boolean;
  /** В каталог обходчик не спускается (`childrenIgnored`). */
  prunesDir(rel: string, name: string): boolean;
}

/**
 * Фильтр как у `createIgnoreFilter` GitNexus: тексты корневых `.gitignore` и `.gitnexusignore` (пакет `ignore`,
 * без учёта регистра), `!правило` пользователя сильнее встроенного списка, затем встроенные правила.
 * `null` — файла нет. Вложенные `.gitignore` GitNexus не читает, поэтому их здесь нет.
 */
export function createGitNexusFilter(gitignore: string | null, gitnexusignore: string | null): GitNexusFilter {
  const texts = [gitignore, gitnexusignore].filter((text): text is string => text !== null);
  // Каждый файл — отдельным add(текст): элементы массива `ignore` по строкам не разбивает.
  const ig = texts.length > 0 ? texts.reduce((acc, text) => acc.add(text), ignore()) : null;
  return {
    ignoresFile(rel) {
      if (!rel) return false;
      if (ig && hasExplicitUnignore(ig, rel) && !ig.ignores(rel)) return false;
      if (ig && ig.ignores(rel)) return true;
      return gitnexusHardcodedIgnore(rel);
    },
    prunesDir(rel, name) {
      if (ig && rel && hasExplicitUnignore(ig, rel) && !ig.ignores(`${rel}/`)) return false;
      if (GITNEXUS_DEFAULT_IGNORE_DIRS.has(name)) return true;
      return Boolean(ig && rel && ig.ignores(`${rel}/`));
    }
  };
}
