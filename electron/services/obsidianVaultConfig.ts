/**
 * Конфиг хранилища Obsidian для `backlog/` (TASK-178, decision-133): чистые функции без Electron и файловой
 * системы — содержимое файлов `.obsidian/`, слияние списка плагинов и записи в реестре хранилищ Obsidian.
 */
import { DOC_KIND_COLORS } from '../../src/utils/docLinkGraph';

export const OBSIDIAN_PLUGIN_ID = 'projecthub-links';

/** Файлы `.obsidian/`, которые ProjectHub создаёт только при отсутствии: дальше это настройки человека. */
export function obsidianDefaultFiles(): Record<string, string> {
  const appConfig = {
    // Ссылки — вики-ссылки по кратчайшему пути, как пишет ProjectHub; переименование файла правит ссылки.
    useMarkdownLinks: false,
    newLinkFormat: 'shortest',
    alwaysUpdateLinks: true,
    // Картинки — в каталог ассетов документации (правило 15 infra-dev).
    attachmentFolderPath: 'docs/assets',
    // Свойства frontmatter Backlog.md (id, status, section) видны, но не мешают тексту.
    propertiesInDocument: 'visible'
  };
  // Цвета групп графа — те же виды, что у вкладки «Граф документации» ProjectHub.
  const color = (hex: string) => ({ a: 1, rgb: Number.parseInt(hex.slice(1), 16) });
  const graphConfig = {
    showTags: false,
    showAttachments: false,
    hideUnresolved: false,
    showOrphans: true,
    showArrow: true,
    colorGroups: [
      { query: 'path:decisions', color: color(DOC_KIND_COLORS.decision) },
      { query: 'path:docs', color: color(DOC_KIND_COLORS.doc) },
      { query: 'path:tasks', color: color(DOC_KIND_COLORS.task) },
      { query: 'path:memory', color: color(DOC_KIND_COLORS.mem) }
    ]
  };
  return {
    'app.json': `${JSON.stringify(appConfig, null, 2)}\n`,
    'graph.json': `${JSON.stringify(graphConfig, null, 2)}\n`,
    // Состояние окон и кэш у каждого своё — в git идут только настройки и плагин.
    '.gitignore': ['workspace.json', 'workspace-mobile.json', 'cache', ''].join('\n')
  };
}

/** `community-plugins.json` с нашим плагином: чужие плагины и их порядок сохраняются. */
export function mergeCommunityPlugins(current: string | null): { content: string; changed: boolean } {
  let list: unknown = [];
  if (current) {
    try {
      list = JSON.parse(current);
    } catch {
      // битый файл Obsidian тоже не прочитает — заменяем рабочим
      list = [];
    }
  }
  const plugins = Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : [];
  if (plugins.includes(OBSIDIAN_PLUGIN_ID)) return { content: current ?? '', changed: false };
  return { content: `${JSON.stringify([...plugins, OBSIDIAN_PLUGIN_ID], null, 2)}\n`, changed: true };
}

export interface ObsidianVaultEntry {
  path: string;
  ts?: number;
  open?: boolean;
}

export interface ObsidianRegistry {
  vaults?: Record<string, ObsidianVaultEntry>;
  [key: string]: unknown;
}

function samePath(a: string, b: string, caseInsensitive: boolean): boolean {
  const norm = (p: string) => {
    const s = p.replace(/[\\/]+/g, '/').replace(/\/$/, '');
    return caseInsensitive ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

/** id хранилища с этим путём в `obsidian.json` или `null`. На Windows и macOS регистр пути не важен. */
export function findRegisteredVault(registry: ObsidianRegistry, vaultPath: string, platform: NodeJS.Platform): string | null {
  const caseInsensitive = platform === 'win32' || platform === 'darwin';
  for (const [id, entry] of Object.entries(registry.vaults ?? {})) {
    if (entry && typeof entry.path === 'string' && samePath(entry.path, vaultPath, caseInsensitive)) return id;
  }
  return null;
}

/** Реестр с новым хранилищем; id — 16 hex-символов, как у самого Obsidian. */
export function addVaultToRegistry(registry: ObsidianRegistry, vaultPath: string, id: string, ts: number): ObsidianRegistry {
  return { ...registry, vaults: { ...(registry.vaults ?? {}), [id]: { path: vaultPath, ts } } };
}
