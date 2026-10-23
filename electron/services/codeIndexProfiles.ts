/**
 * Профили индексации кода GitNexus по стеку и блок ProjectHub в `.gitnexusignore` (decision-131, TASK-176).
 *
 * У `gitnexus analyze` нет флагов include/exclude, а `.gitnexusrc` не знает таких ключей, поэтому единственный
 * рычаг — корневой `.gitnexusignore` в синтаксисе gitignore. ProjectHub ведёт в нём один размеченный блок
 * в начале файла; строки пользователя вне блока не трогаются и, стоя ниже, перекрывают блок (`!шаблон`).
 * Выбор пользователя хранится в самом блоке строкой `# projecthub:settings {...}`: файл коммитится, и команда
 * получает те же исключения без ProjectHub.
 *
 * Чистый модуль без Electron и без чтения диска (правило 17).
 */
import { AppError } from '../../src/lib/appError.js';
import type { StackId } from './initStack.js';

export type IndexProfileId = 'unreal' | 'unity' | 'godot' | 'node' | 'python' | 'dotnet' | 'go' | 'rust' | 'java' | 'flutter' | 'cpp';
export type IndexGroupKind = 'case' | 'engine' | 'vendor' | 'generated' | 'build' | 'assets';

export interface Localized {
  ru: string;
  en: string;
}

export interface IndexProfile {
  id: IndexProfileId;
  label: Localized;
  /** Стеки `initStack.ts`, при которых профиль предлагается. */
  stacks: StackId[];
}

export interface IndexGroup {
  id: string;
  /** `common` — группа для любого стека. */
  profile: IndexProfileId | 'common';
  kind: IndexGroupKind;
  label: Localized;
  description: Localized;
  /** Включена при выборе профиля. */
  default: boolean;
  /** Шаблоны в синтаксисе gitignore. Каталог — с завершающим `/`, корень репозитория — с ведущим `/`. */
  patterns: string[];
  /** Можно оставить в индексе только заголовки C/C++ — «точки входа» библиотеки. */
  headers?: boolean;
}

/** Что известно о проекте сверх стека: найденные плагины маркетплейса UE (`Plugins/Имя`). */
export interface IndexContext {
  marketplacePlugins: string[];
}

export interface CodeIndexSettings {
  profiles: IndexProfileId[];
  /** id включённых групп. */
  groups: string[];
  /** id включённых групп, у которых в индексе остаются только заголовки. */
  headersOnly: string[];
  /** Свои шаблоны пользователя, gitignore-синтаксис. */
  custom: string[];
}

export const EMPTY_CONTEXT: IndexContext = { marketplacePlugins: [] };

/**
 * Флаги `gitnexus analyze` из ProjectHub, шаблона и хука post-commit: без них analyze дописывает свою секцию
 * в CLAUDE.md/AGENTS.md и кладёт скиллы в `.claude/skills/gitnexus`.
 */
export const GITNEXUS_ANALYZE_FLAGS = ['--skip-agents-md', '--skip-skills'] as const;

/** Команда переиндексации. `force` — полная пересборка: после смены правил чистое дерево analyze считает актуальным. */
export function gitnexusAnalyzeCommand(force = false): string {
  return ['gitnexus', 'analyze', ...(force ? ['--force'] : []), ...GITNEXUS_ANALYZE_FLAGS].join(' ');
}

export const INDEX_PROFILES: readonly IndexProfile[] = [
  { id: 'unreal', label: { ru: 'Unreal Engine', en: 'Unreal Engine' }, stacks: ['unreal'] },
  { id: 'unity', label: { ru: 'Unity', en: 'Unity' }, stacks: ['unity'] },
  { id: 'godot', label: { ru: 'Godot', en: 'Godot' }, stacks: ['godot'] },
  { id: 'node', label: { ru: 'Node.js и фронтенд-фреймворки', en: 'Node.js and frontend frameworks' }, stacks: ['node'] },
  { id: 'python', label: { ru: 'Python', en: 'Python' }, stacks: ['python'] },
  { id: 'dotnet', label: { ru: '.NET', en: '.NET' }, stacks: ['dotnet'] },
  { id: 'go', label: { ru: 'Go', en: 'Go' }, stacks: ['go'] },
  { id: 'rust', label: { ru: 'Rust', en: 'Rust' }, stacks: ['rust'] },
  { id: 'java', label: { ru: 'Java/Kotlin (Gradle, Maven, Android)', en: 'Java/Kotlin (Gradle, Maven, Android)' }, stacks: ['java-gradle', 'java-maven'] },
  { id: 'flutter', label: { ru: 'Flutter/Dart', en: 'Flutter/Dart' }, stacks: ['flutter'] },
  { id: 'cpp', label: { ru: 'C/C++ (CMake)', en: 'C/C++ (CMake)' }, stacks: ['cpp-cmake'] }
];

/** Расширения заголовков, которые остаются в индексе в режиме «только точки входа». */
export const HEADER_EXTENSIONS = ['h', 'hh', 'hpp', 'hxx', 'inl', 'ipp'] as const;

/** Каталоги плагинов маркетплейса, которые UE и Fab создают сами. */
const MARKETPLACE_DIRS = ['/Plugins/Marketplace/', '/Plugins/Fab/'];

export const INDEX_GROUPS: readonly IndexGroup[] = [
  {
    id: 'common.case',
    profile: 'common',
    kind: 'case',
    label: { ru: 'Встроенный список без учёта регистра', en: 'Built-in list, case-insensitive' },
    description: {
      ru: 'GitNexus сравнивает свой список каталогов с учётом регистра: Vendor/, ThirdParty/, Build/, Bin/ попадают в индекс. Здесь те же каталоги без учёта регистра.',
      en: 'GitNexus matches its built-in directory list case-sensitively, so Vendor/, ThirdParty/, Build/, Bin/ get indexed. These lines exclude them in any case.'
    },
    default: true,
    patterns: ['vendor/', 'third_party/', 'thirdparty/', '3rdparty/', 'node_modules/', 'dist/', 'build/', 'out/', 'bin/', 'obj/']
  },
  // ── Unreal Engine ──────────────────────────────────────────────────────────────────────
  {
    id: 'unreal.engine',
    profile: 'unreal',
    kind: 'engine',
    label: { ru: 'Движок (исходная сборка)', en: 'Engine (source build)' },
    description: {
      ru: 'Engine/ и служебные каталоги исходной сборки UE в корне репозитория.',
      en: 'Engine/ and other source-build folders at the repository root.'
    },
    default: true,
    patterns: ['/Engine/', '/FeaturePacks/', '/Samples/', '/Templates/'],
    headers: true
  },
  {
    id: 'unreal.thirdparty',
    profile: 'unreal',
    kind: 'vendor',
    label: { ru: 'Сторонние библиотеки ThirdParty', en: 'ThirdParty libraries' },
    description: {
      ru: 'Каталоги ThirdParty на любой глубине: Source/ThirdParty, Plugins/*/Source/ThirdParty.',
      en: 'ThirdParty folders at any depth: Source/ThirdParty, Plugins/*/Source/ThirdParty.'
    },
    default: true,
    patterns: ['ThirdParty/'],
    headers: true
  },
  {
    id: 'unreal.marketplace',
    profile: 'unreal',
    kind: 'vendor',
    label: { ru: 'Плагины маркетплейса и Fab', en: 'Marketplace and Fab plugins' },
    description: {
      ru: 'Plugins/Marketplace, Plugins/Fab и плагины, у которых в .uplugin указан MarketplaceURL или FabURL.',
      en: 'Plugins/Marketplace, Plugins/Fab and plugins whose .uplugin has a MarketplaceURL or FabURL.'
    },
    default: true,
    patterns: MARKETPLACE_DIRS,
    headers: true
  },
  {
    id: 'unreal.build',
    profile: 'unreal',
    kind: 'build',
    label: { ru: 'Промежуточные и собранные файлы', en: 'Intermediate and build output' },
    description: { ru: 'Intermediate, Saved, Binaries, DerivedDataCache — и у плагинов тоже.', en: 'Intermediate, Saved, Binaries, DerivedDataCache, plugins included.' },
    default: true,
    patterns: ['Intermediate/', 'Saved/', 'Binaries/', 'DerivedDataCache/']
  },
  {
    id: 'unreal.generated',
    profile: 'unreal',
    kind: 'generated',
    label: { ru: 'Код UnrealHeaderTool', en: 'UnrealHeaderTool output' },
    description: { ru: '*.generated.h и *.gen.cpp.', en: '*.generated.h and *.gen.cpp.' },
    default: true,
    patterns: ['*.generated.h', '*.gen.cpp']
  },
  {
    id: 'unreal.assets',
    profile: 'unreal',
    kind: 'assets',
    label: { ru: 'Двоичные ассеты', en: 'Binary assets' },
    description: { ru: '.uasset, .umap и их спутники — не код.', en: '.uasset, .umap and their companions are not code.' },
    default: true,
    patterns: ['*.uasset', '*.umap', '*.uexp', '*.ubulk', '*.upk']
  },
  // ── Unity ──────────────────────────────────────────────────────────────────────────────
  {
    id: 'unity.library',
    profile: 'unity',
    kind: 'build',
    label: { ru: 'Library, Temp и сборки', en: 'Library, Temp and builds' },
    description: { ru: 'Кэш редактора (там же PackageCache), временные файлы, логи и сборки.', en: 'Editor cache (PackageCache lives there), temp files, logs and builds.' },
    default: true,
    patterns: ['/Library/', '/Temp/', '/Obj/', '/Logs/', '/UserSettings/', '/Build/', '/Builds/', '/MemoryCaptures/']
  },
  {
    id: 'unity.packages',
    profile: 'unity',
    kind: 'vendor',
    label: { ru: 'Пакеты Packages/', en: 'Packages/ folder' },
    description: {
      ru: 'Встроенные и локальные пакеты. Свой код в Packages/ — снимите галочку или верните его строкой !Packages/Мой.Пакет/ ниже блока.',
      en: 'Embedded and local packages. Own code in Packages/ — untick this or re-include it with !Packages/My.Package/ below the block.'
    },
    default: true,
    patterns: ['/Packages/']
  },
  {
    id: 'unity.plugins',
    profile: 'unity',
    kind: 'vendor',
    label: { ru: 'Сторонние плагины Assets/Plugins', en: 'Third-party Assets/Plugins' },
    description: { ru: 'Assets/Plugins — обычное место плагинов Asset Store.', en: 'Assets/Plugins is where Asset Store plugins usually go.' },
    default: true,
    patterns: ['/Assets/Plugins/']
  },
  {
    id: 'unity.assets',
    profile: 'unity',
    kind: 'assets',
    label: { ru: 'Сериализованные ассеты', en: 'Serialized assets' },
    description: { ru: '.meta, сцены, префабы и прочий YAML Unity.', en: '.meta, scenes, prefabs and other Unity YAML.' },
    default: true,
    patterns: ['*.meta', '*.unity', '*.prefab', '*.asset', '*.mat', '*.anim', '*.controller']
  },
  // ── Godot ──────────────────────────────────────────────────────────────────────────────
  {
    id: 'godot.addons',
    profile: 'godot',
    kind: 'vendor',
    label: { ru: 'Аддоны addons/', en: 'addons/ plugins' },
    description: { ru: 'Сторонние плагины из Asset Library.', en: 'Third-party plugins from the Asset Library.' },
    default: true,
    patterns: ['/addons/']
  },
  {
    id: 'godot.imports',
    profile: 'godot',
    kind: 'generated',
    label: { ru: 'Файлы импорта', en: 'Import files' },
    description: { ru: '*.import рядом с ассетами.', en: '*.import next to assets.' },
    default: true,
    patterns: ['*.import']
  },
  // ── Node.js ────────────────────────────────────────────────────────────────────────────
  {
    id: 'node.output',
    profile: 'node',
    kind: 'build',
    label: { ru: 'Сборки фреймворков', en: 'Framework build output' },
    description: { ru: 'storybook-static, dist-electron, www и *.tsbuildinfo. Каталоги с точкой GitNexus и так пропускает.', en: 'storybook-static, dist-electron, www and *.tsbuildinfo. Dot folders are skipped by GitNexus anyway.' },
    default: true,
    patterns: ['storybook-static/', 'dist-electron/', '/www/', '*.tsbuildinfo']
  },
  {
    id: 'node.generated',
    profile: 'node',
    kind: 'generated',
    label: { ru: 'Сгенерированный код', en: 'Generated code' },
    description: { ru: '__generated__ (GraphQL, Relay), *.gen.ts, protobuf (*_pb.js).', en: '__generated__ (GraphQL, Relay), *.gen.ts, protobuf (*_pb.js).' },
    default: true,
    patterns: ['__generated__/', '*.gen.ts', '*.gen.js', '*_pb.js', '*_pb.ts']
  },
  {
    id: 'node.vendor',
    profile: 'node',
    kind: 'vendor',
    label: { ru: 'Вендоренные библиотеки', en: 'Vendored libraries' },
    description: { ru: 'web_modules, public/lib, static/vendor.', en: 'web_modules, public/lib, static/vendor.' },
    default: true,
    patterns: ['web_modules/', 'public/lib/', 'static/vendor/']
  },
  // ── Python ─────────────────────────────────────────────────────────────────────────────
  {
    id: 'python.envs',
    profile: 'python',
    kind: 'vendor',
    label: { ru: 'Окружения и пакеты', en: 'Environments and packages' },
    description: { ru: '__pypackages__, *.egg-info и окружения conda. venv/ и site-packages/ GitNexus исключает сам.', en: '__pypackages__, *.egg-info and conda envs. GitNexus already skips venv/ and site-packages/.' },
    default: true,
    patterns: ['__pypackages__/', '*.egg-info/', 'conda-meta/', '/envs/']
  },
  {
    id: 'python.generated',
    profile: 'python',
    kind: 'generated',
    label: { ru: 'Сгенерированный код', en: 'Generated code' },
    description: { ru: 'protobuf и gRPC (*_pb2.py).', en: 'protobuf and gRPC (*_pb2.py).' },
    default: true,
    patterns: ['*_pb2.py', '*_pb2_grpc.py', '*_pb2.pyi']
  },
  {
    id: 'python.migrations',
    profile: 'python',
    kind: 'generated',
    label: { ru: 'Миграции Django/Alembic', en: 'Django/Alembic migrations' },
    description: { ru: 'Сгенерированы, но иногда правятся руками — выключено по умолчанию.', en: 'Generated, but sometimes edited by hand — off by default.' },
    default: false,
    patterns: ['migrations/', 'alembic/versions/']
  },
  // ── .NET ───────────────────────────────────────────────────────────────────────────────
  {
    id: 'dotnet.packages',
    profile: 'dotnet',
    kind: 'vendor',
    label: { ru: 'Пакеты NuGet и артефакты', en: 'NuGet packages and artifacts' },
    description: { ru: 'packages/ старого формата, TestResults, artifacts.', en: 'Legacy packages/, TestResults, artifacts.' },
    default: true,
    patterns: ['/packages/', 'TestResults/', '/artifacts/', 'BenchmarkDotNet.Artifacts/']
  },
  {
    id: 'dotnet.generated',
    profile: 'dotnet',
    kind: 'generated',
    label: { ru: 'Сгенерированный код', en: 'Generated code' },
    description: { ru: '*.Designer.cs, *.g.cs, *.g.i.cs, AssemblyAttributes.', en: '*.Designer.cs, *.g.cs, *.g.i.cs, AssemblyAttributes.' },
    default: true,
    patterns: ['*.Designer.cs', '*.g.cs', '*.g.i.cs', '*.AssemblyAttributes.cs']
  },
  // ── Go ─────────────────────────────────────────────────────────────────────────────────
  {
    id: 'go.generated',
    profile: 'go',
    kind: 'generated',
    label: { ru: 'Сгенерированный код', en: 'Generated code' },
    description: { ru: 'protobuf (*.pb.go), *_gen.go, zz_generated*.go. vendor/ GitNexus исключает сам.', en: 'protobuf (*.pb.go), *_gen.go, zz_generated*.go. GitNexus already skips vendor/.' },
    default: true,
    patterns: ['*.pb.go', '*.pb.gw.go', '*_gen.go', 'zz_generated*.go']
  },
  {
    id: 'go.mocks',
    profile: 'go',
    kind: 'generated',
    label: { ru: 'Моки', en: 'Mocks' },
    description: { ru: 'mock_*.go и каталоги mocks/.', en: 'mock_*.go and mocks/ folders.' },
    default: false,
    patterns: ['mock_*.go', 'mocks/']
  },
  // ── Rust ───────────────────────────────────────────────────────────────────────────────
  {
    id: 'rust.vendor',
    profile: 'rust',
    kind: 'vendor',
    label: { ru: 'Сборка и вендоринг', en: 'Build output and vendoring' },
    description: { ru: 'target/ и vendor/ в любом регистре, cargo vendor в .cargo/ GitNexus пропускает сам.', en: 'target/ and vendor/ in any case; GitNexus skips .cargo/ itself.' },
    default: true,
    patterns: ['target/', 'vendor/']
  },
  // ── Java/Kotlin ────────────────────────────────────────────────────────────────────────
  {
    id: 'java.build',
    profile: 'java',
    kind: 'build',
    label: { ru: 'Сборка Gradle/Maven', en: 'Gradle/Maven output' },
    description: { ru: 'build/, target/, out/ в любом регистре.', en: 'build/, target/, out/ in any case.' },
    default: true,
    patterns: ['build/', 'target/', 'out/']
  },
  {
    id: 'java.generated',
    profile: 'java',
    kind: 'generated',
    label: { ru: 'Сгенерированный код Android', en: 'Android generated code' },
    description: { ru: 'R.java, BuildConfig.java, *_ViewBinding.java.', en: 'R.java, BuildConfig.java, *_ViewBinding.java.' },
    default: true,
    patterns: ['R.java', 'BuildConfig.java', '*_ViewBinding.java']
  },
  // ── Flutter/Dart ───────────────────────────────────────────────────────────────────────
  {
    id: 'flutter.platform',
    profile: 'flutter',
    kind: 'vendor',
    label: { ru: 'Платформенные зависимости', en: 'Platform dependencies' },
    description: { ru: 'CocoaPods и ephemeral-каталоги платформ.', en: 'CocoaPods and platform ephemeral folders.' },
    default: true,
    patterns: ['ios/Pods/', 'macos/Pods/', 'ios/Flutter/', '**/flutter/ephemeral/']
  },
  {
    id: 'flutter.generated',
    profile: 'flutter',
    kind: 'generated',
    label: { ru: 'Сгенерированный код', en: 'Generated code' },
    description: { ru: '*.g.dart, *.freezed.dart, *.gr.dart, *.mocks.dart, *.pb.dart, регистраторы плагинов.', en: '*.g.dart, *.freezed.dart, *.gr.dart, *.mocks.dart, *.pb.dart, plugin registrants.' },
    default: true,
    patterns: ['*.g.dart', '*.freezed.dart', '*.gr.dart', '*.mocks.dart', '*.pb.dart', 'generated_plugin_registrant.*']
  },
  // ── C/C++ ──────────────────────────────────────────────────────────────────────────────
  {
    id: 'cpp.vendor',
    profile: 'cpp',
    kind: 'vendor',
    label: { ru: 'Вендоренные библиотеки', en: 'Vendored libraries' },
    description: { ru: 'external/, extern/, _deps/ (FetchContent), subprojects/ (Meson).', en: 'external/, extern/, _deps/ (FetchContent), subprojects/ (Meson).' },
    default: true,
    patterns: ['external/', 'extern/', '_deps/', 'subprojects/'],
    headers: true
  },
  {
    id: 'cpp.build',
    profile: 'cpp',
    kind: 'build',
    label: { ru: 'Каталоги сборки CMake', en: 'CMake build folders' },
    description: { ru: 'cmake-build-*, CMakeFiles.', en: 'cmake-build-*, CMakeFiles.' },
    default: true,
    patterns: ['cmake-build-*/', 'CMakeFiles/']
  }
];

const PROFILE_IDS = new Set<string>(INDEX_PROFILES.map((profile) => profile.id));
const GROUPS_BY_ID = new Map(INDEX_GROUPS.map((group) => [group.id, group]));

// ---------------------------------------------------------------------------------------
// Выбор профиля и групп
// ---------------------------------------------------------------------------------------

/**
 * Профили для найденных стеков. `.sln` в корне UE-проекта даёт стек .NET, но это файл UnrealBuildTool:
 * рядом с Unreal профиль .NET не предлагается.
 */
export function profilesForStacks(stackIds: readonly string[]): IndexProfileId[] {
  const result = INDEX_PROFILES.filter((profile) => profile.stacks.some((stack) => stackIds.includes(stack))).map((profile) => profile.id);
  return result.includes('unreal') ? result.filter((id) => id !== 'dotnet') : result;
}

/** Группы, доступные при выбранных профилях: общие и профильные, в порядке каталога. */
export function groupsForProfiles(profiles: readonly IndexProfileId[]): IndexGroup[] {
  return INDEX_GROUPS.filter((group) => group.profile === 'common' || profiles.includes(group.profile));
}

/** Настройки по умолчанию: включённые по умолчанию группы выбранных профилей. */
export function defaultIndexSettings(profiles: readonly IndexProfileId[]): CodeIndexSettings {
  return {
    profiles: [...profiles],
    groups: groupsForProfiles(profiles).filter((group) => group.default).map((group) => group.id),
    headersOnly: [],
    custom: []
  };
}

/** Строки блока, которые пользователь не может записать как свой шаблон: они сломали бы разметку. */
function isReservedLine(line: string): boolean {
  return /^#\s*(>>>|<<<)\s*projecthub:generated/.test(line) || /^#\s*projecthub:settings/.test(line);
}

const MAX_CUSTOM = 500;
const MAX_LINE = 300;

/** Свои шаблоны: по строке, без пустых, повторов и служебных строк блока. */
export function normalizeCustomPatterns(lines: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of lines) {
    if (typeof raw !== 'string') continue;
    for (const part of raw.split(/\r?\n/)) {
      const line = part.trim();
      if (!line || line.length > MAX_LINE || isReservedLine(line) || seen.has(line)) continue;
      seen.add(line);
      result.push(line);
      if (result.length >= MAX_CUSTOM) return result;
    }
  }
  return result;
}

/**
 * Проверка настроек из блока или от интерфейса: неизвестные профили и группы отбрасываются, группа живёт,
 * только если выбран её профиль. Не объект — `null`.
 */
export function normalizeIndexSettings(raw: unknown): CodeIndexSettings | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const list = (key: string): unknown[] => (Array.isArray(value[key]) ? (value[key] as unknown[]) : []);
  const profiles = INDEX_PROFILES.map((profile) => profile.id).filter((id) => list('profiles').includes(id));
  const available = new Set(groupsForProfiles(profiles).map((group) => group.id));
  const groups = INDEX_GROUPS.map((group) => group.id).filter((id) => available.has(id) && list('groups').includes(id));
  const headersOnly = groups.filter((id) => GROUPS_BY_ID.get(id)?.headers && list('headersOnly').includes(id));
  return { profiles, groups, headersOnly, custom: normalizeCustomPatterns(list('custom')) };
}

export function isIndexProfileId(value: unknown): value is IndexProfileId {
  return typeof value === 'string' && PROFILE_IDS.has(value);
}

// ---------------------------------------------------------------------------------------
// Плагины маркетплейса Unreal Engine
// ---------------------------------------------------------------------------------------

/** Плагин из маркетплейса или Fab: так его помечают сам магазин и лаунчер в `.uplugin`. */
export function isMarketplacePlugin(descriptor: unknown): boolean {
  if (!descriptor || typeof descriptor !== 'object') return false;
  const d = descriptor as Record<string, unknown>;
  const nonEmpty = (key: string) => typeof d[key] === 'string' && (d[key] as string).trim() !== '';
  return nonEmpty('MarketplaceURL') || nonEmpty('FabURL') || d.Installed === true;
}

// ---------------------------------------------------------------------------------------
// Шаблоны группы
// ---------------------------------------------------------------------------------------

/** Шаблоны группы с учётом проекта: у плагинов маркетплейса добавляются найденные каталоги. */
export function groupPatterns(group: IndexGroup, context: IndexContext): string[] {
  if (group.id !== 'unreal.marketplace') return [...group.patterns];
  const found = context.marketplacePlugins
    .map((dir) => dir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter((dir) => dir && !/[*?[\]!#]/.test(dir))
    .map((dir) => `/${dir}/`);
  return [...new Set([...group.patterns, ...found])];
}

/**
 * Каталог → «только заголовки»: содержимое исключено, подкаталоги и заголовки возвращены. Исключить сам
 * каталог нельзя: gitignore не возвращает файлы из исключённого каталога. Шаблон без `/` в середине
 * совпадает на любой глубине, поэтому получает префикс «любой путь» (две звёздочки и слэш). Шаблоны файлов
 * не меняются.
 */
export function headersOnlyPatterns(pattern: string): string[] {
  if (!pattern.endsWith('/')) return [pattern];
  const base = dirBase(pattern);
  return [`${base}/**`, `!${base}/**/`, ...HEADER_EXTENSIONS.map((ext) => `!${base}/**/*.${ext}`)];
}

/** Каталог без завершающего `/`; шаблон без `/` в середине совпадает на любой глубине, поэтому — с «любым путём» спереди. */
function dirBase(pattern: string): string {
  const body = pattern.slice(0, -1);
  return body.startsWith('/') || body.includes('/') ? body : `**/${body}`;
}

/**
 * Каталог → его содержимое: `ThirdParty/` пишется как «всё внутри ThirdParty». Исключённый целиком каталог
 * не вернуть строкой `!` ниже блока: и git, и пакет `ignore` у GitNexus проверяют родителей. Исключив только
 * содержимое, пользователь может вернуть подкаталог: `!Source/ThirdParty/MyLib/`.
 */
export function contentPattern(pattern: string): string {
  return pattern.endsWith('/') ? `${dirBase(pattern)}/*` : pattern;
}

// ---------------------------------------------------------------------------------------
// Блок в .gitnexusignore
// ---------------------------------------------------------------------------------------

export const BLOCK_START = '# >>> projecthub:generated';
export const BLOCK_END = '# <<< projecthub:generated';
const SETTINGS_PREFIX = '# projecthub:settings ';

const START_RE = /^#\s*>>>\s*projecthub:generated\b/;
const END_RE = /^#\s*<<<\s*projecthub:generated\b/;
const SETTINGS_RE = /^#\s*projecthub:settings\s+(.*)$/;

export type IndexLocale = 'ru' | 'en';

const BLOCK_NOTE: Localized = {
  ru: 'индексация GitNexus, ведёт ProjectHub (decision-131). Правки внутри блока перезапишутся: свои строки пишите ниже, они перекрывают блок.',
  en: 'GitNexus indexing, managed by ProjectHub (decision-131). Edits inside the block are overwritten: add your lines below, they override the block.'
};
const CUSTOM_TITLE: Localized = { ru: 'Свои шаблоны', en: 'Custom patterns' };
const HEADERS_NOTE: Localized = { ru: 'только заголовки', en: 'headers only' };

/** Строки блока без маркеров начала и конца. */
export function renderIndexBlockBody(settings: CodeIndexSettings, context: IndexContext, locale: IndexLocale = 'ru'): string[] {
  const lines = [`${SETTINGS_PREFIX}${JSON.stringify({ v: 1, ...settings })}`];
  const profileLabel = (id: IndexGroup['profile']) =>
    id === 'common' ? 'GitNexus' : (INDEX_PROFILES.find((profile) => profile.id === id)?.label[locale] ?? id);
  const headersOf = (group: IndexGroup) => Boolean(group.headers && settings.headersOnly.includes(group.id));
  const enabled = INDEX_GROUPS.filter((group) => settings.groups.includes(group.id));
  // Группы «только заголовки» — в конце: их `!` должны перекрыть общие строки вроде `thirdparty/` (последнее совпадение побеждает).
  for (const group of [...enabled.filter((g) => !headersOf(g)), ...enabled.filter(headersOf)]) {
    const headers = headersOf(group);
    const patterns = groupPatterns(group, context).flatMap((pattern) => (headers ? headersOnlyPatterns(pattern) : [contentPattern(pattern)]));
    lines.push('', `# ${profileLabel(group.profile)} — ${group.label[locale]}${headers ? ` (${HEADERS_NOTE[locale]})` : ''}`, ...patterns);
  }
  if (settings.custom.length > 0) lines.push('', `# ${CUSTOM_TITLE[locale]}`, ...settings.custom);
  return lines;
}

/** Блок целиком, без завершающего перевода строки. */
export function renderIndexBlock(settings: CodeIndexSettings, context: IndexContext, locale: IndexLocale = 'ru'): string {
  return [`${BLOCK_START} — ${BLOCK_NOTE[locale]}`, ...renderIndexBlockBody(settings, context, locale), BLOCK_END].join('\n');
}

export interface ParsedGitnexusIgnore {
  /** Блок ProjectHub есть и закрыт. */
  hasBlock: boolean;
  /** Начало блока без конца: писать в такой файл нельзя, можно испортить строки пользователя. */
  broken: boolean;
  /** Настройки из строки `projecthub:settings`; нет или не читаются — `null`. */
  settings: CodeIndexSettings | null;
  /** Текст файла без блока — строки пользователя как есть (LF). */
  userText: string;
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function locateBlock(lines: string[]): { start: number; end: number } | { start: number; end: -1 } | null {
  const start = lines.findIndex((line) => START_RE.test(line.trim()));
  if (start === -1) return null;
  const offset = lines.slice(start + 1).findIndex((line) => END_RE.test(line.trim()));
  return { start, end: offset === -1 ? -1 : start + 1 + offset };
}

/** Разбор `.gitnexusignore`: блок ProjectHub, его настройки и строки пользователя. `null` — файла нет. */
export function parseGitnexusIgnore(text: string | null): ParsedGitnexusIgnore {
  if (text === null) return { hasBlock: false, broken: false, settings: null, userText: '' };
  const lines = toLf(text).split('\n');
  const found = locateBlock(lines);
  if (!found) return { hasBlock: false, broken: false, settings: null, userText: lines.join('\n') };
  if (found.end === -1) return { hasBlock: false, broken: true, settings: null, userText: lines.join('\n') };
  let settings: CodeIndexSettings | null = null;
  for (const line of lines.slice(found.start + 1, found.end)) {
    const match = SETTINGS_RE.exec(line.trim());
    if (!match) continue;
    try {
      settings = normalizeIndexSettings(JSON.parse(match[1]));
    } catch {
      settings = null;
    }
    break;
  }
  const userLines = [...lines.slice(0, found.start), ...lines.slice(found.end + 1)];
  // Пустая строка-разделитель, которую ставит upsertIndexBlock после блока, — не строка пользователя.
  if (found.start === 0 && userLines[0] === '') userLines.shift();
  return { hasBlock: true, broken: false, settings, userText: userLines.join('\n') };
}

export class BrokenIndexBlockError extends AppError {
  constructor() {
    super('graph.brokenIndexBlock');
    this.name = 'BrokenIndexBlockError';
  }
}

/**
 * Новый текст `.gitnexusignore`: блок заменяется на месте, а если его не было — встаёт в начало файла, чтобы
 * строки пользователя шли после него и перекрывали его. Строки вне блока и вид переводов строк сохраняются.
 */
export function upsertIndexBlock(existing: string | null, block: string): string {
  if (existing === null || !existing.trim()) return `${block}\n`;
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = toLf(existing).split('\n');
  const found = locateBlock(lines);
  if (found && found.end === -1) throw new BrokenIndexBlockError();
  const blockLines = block.split('\n');
  const next = found
    ? [...lines.slice(0, found.start), ...blockLines, ...lines.slice(found.end + 1)]
    : [...blockLines, '', ...lines];
  const text = next.join('\n');
  return eol === '\n' ? text : text.replace(/\n/g, eol);
}

/** Все шаблоны, которые блок с этими настройками добавит (для предпросмотра без записи файла). */
export function indexBlockPatterns(settings: CodeIndexSettings, context: IndexContext): string[] {
  return renderIndexBlockBody(settings, context).filter((line) => line && !line.startsWith('#'));
}
