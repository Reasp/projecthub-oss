/**
 * Определение стека проекта по файлам корня для строк `.gitignore` основы (decision-78, п. 1).
 * Стек не выбирается и ничего не ставит: он только подсказывает, какие каталоги сборки и
 * зависимостей не должны попасть в git. Чистый модуль без Electron (правило 17).
 */

export type StackId =
  | 'node'
  | 'python'
  | 'rust'
  | 'go'
  | 'dotnet'
  | 'java-maven'
  | 'java-gradle'
  | 'unreal'
  | 'unity'
  | 'godot'
  | 'flutter'
  | 'cpp-cmake';

export interface StackInfo {
  id: StackId;
  label: string;
  gitignore: string[];
}

interface StackRule extends StackInfo {
  /** Совпадение по имени файла или каталога корня (без учёта регистра). */
  match: (names: Set<string>, all: string[]) => boolean;
}

const has = (...files: string[]) => (names: Set<string>) => files.some((file) => names.has(file));
const hasExt = (...exts: string[]) => (_names: Set<string>, all: string[]) =>
  all.some((name) => exts.some((ext) => name.endsWith(ext)));

const RULES: StackRule[] = [
  {
    id: 'node',
    label: 'Node.js',
    match: has('package.json'),
    gitignore: ['node_modules/', 'npm-debug.log*', 'yarn-error.log*', '.pnpm-store/', '*.tsbuildinfo']
  },
  {
    id: 'python',
    label: 'Python',
    match: has('pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'pipfile', 'poetry.lock'),
    gitignore: ['__pycache__/', '*.py[cod]', '.venv/', 'venv/', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', '*.egg-info/']
  },
  { id: 'rust', label: 'Rust', match: has('cargo.toml'), gitignore: ['target/'] },
  { id: 'go', label: 'Go', match: has('go.mod'), gitignore: ['*.test', '*.out'] },
  {
    id: 'dotnet',
    label: '.NET',
    match: hasExt('.csproj', '.fsproj', '.vbproj', '.sln'),
    gitignore: ['bin/', 'obj/', '.vs/', '*.user']
  },
  { id: 'java-maven', label: 'Java (Maven)', match: has('pom.xml'), gitignore: ['target/'] },
  {
    id: 'java-gradle',
    label: 'Java/Kotlin (Gradle)',
    match: has('build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'),
    gitignore: ['.gradle/', 'build/']
  },
  {
    id: 'unreal',
    label: 'Unreal Engine',
    match: hasExt('.uproject'),
    gitignore: ['Binaries/', 'Intermediate/', 'Saved/', 'DerivedDataCache/', '.vs/', '*.sln']
  },
  {
    id: 'unity',
    label: 'Unity',
    match: (names) => names.has('projectsettings') && names.has('assets'),
    gitignore: ['/[Ll]ibrary/', '/[Tt]emp/', '/[Oo]bj/', '/[Ll]ogs/', '/[Uu]ser[Ss]ettings/', '/[Bb]uild/', '/[Bb]uilds/']
  },
  { id: 'godot', label: 'Godot', match: has('project.godot'), gitignore: ['.godot/'] },
  { id: 'flutter', label: 'Flutter/Dart', match: has('pubspec.yaml'), gitignore: ['.dart_tool/', 'build/'] },
  {
    id: 'cpp-cmake',
    label: 'C/C++ (CMake)',
    match: has('cmakelists.txt'),
    gitignore: ['build/', 'cmake-build-*/']
  }
];

/** Строки `.gitignore`, нужные любому проекту независимо от стека. */
export const BASE_GITIGNORE = [
  '.DS_Store',
  'Thumbs.db',
  '.env',
  '.env.local',
  '.env.*.local',
  '.projecthub/backup/'
];

/** Стеки по именам файлов и каталогов корня проекта. Порядок — как в таблице правил. */
export function detectStacks(rootNames: string[]): StackInfo[] {
  const lower = rootNames.map((name) => name.toLowerCase());
  const names = new Set(lower);
  return RULES.filter((rule) => rule.match(names, lower)).map(({ id, label, gitignore }) => ({ id, label, gitignore }));
}

/** Все строки `.gitignore` основы: базовые и под каждый найденный стек, без дублей. */
export function gitignoreLinesFor(stacks: StackInfo[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of [...BASE_GITIGNORE, ...stacks.flatMap((stack) => stack.gitignore)]) {
    if (seen.has(line)) continue;
    seen.add(line);
    result.push(line);
  }
  return result;
}
