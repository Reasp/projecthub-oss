/**
 * Откуда брать обновления (TASK-144.4, decision-172). Чистый модуль без Electron и сети.
 *
 * - Канал `generic` на домене сайта: `<site>/releases/<edition>/latest*.yml`. Включается флагом
 *   `src/lib/updateChannel.json` (`genericEnabled`), когда домен сайта настоящий. До этого — прежний путь: GitHub Releases
 *   публичного зеркала (`app-update.yml` от electron-builder), поведение не меняется.
 * - Канал редакции Team (`/releases/team/`) закрыт токеном заказчика и пока не подключён. Полная сборка сама не
 *   обновляется вовсе (`updateSource` → `none`): релизы зеркала — открытая редакция, и обновление через них молча сняло бы
 *   модули `ee/`. Новую полную сборку заказчик получает по своей ссылке (TASK-200, decision-171).
 * - `PROJECTHUB_UPDATE_FEED_URL` — явный адрес канала для проверки на стенде и тестового сервера; работает при любом флаге.
 */

export interface UpdateFeedInput {
  edition: 'open' | 'team';
  /** Адрес сайта из `productLinks.json`. */
  siteUrl: string | null | undefined;
  genericEnabled: boolean;
  /** Значение `PROJECTHUB_UPDATE_FEED_URL`. */
  override?: string | null;
}

export interface GenericFeed {
  provider: 'generic';
  url: string;
}

/** Заглушка домена до его покупки: на неё канал не включается даже с флагом. */
export const PLACEHOLDER_SITE_HOST = 'projecthub.example';

const withSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`);

function httpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

export function resolveUpdateFeed({ edition, siteUrl, genericEnabled, override }: UpdateFeedInput): GenericFeed | null {
  const forced = override?.trim();
  if (forced) {
    const url = httpUrl(forced);
    return url ? { provider: 'generic', url: withSlash(url.toString()) } : null;
  }
  if (!genericEnabled || edition !== 'open' || !siteUrl) return null;
  const site = httpUrl(siteUrl);
  // Канал обновлений — только по https и только на настоящем домене.
  if (!site || site.protocol !== 'https:' || site.hostname === PLACEHOLDER_SITE_HOST) return null;
  return { provider: 'generic', url: `${withSlash(site.toString())}releases/${edition}/` };
}

/**
 * Откуда обновляться: свой канал `generic`, релизы зеркала (`github`, прежний путь открытой редакции) или ниоткуда —
 * полная сборка без канала Team не должна получить открытую редакцию из зеркала.
 */
export function updateSource(input: UpdateFeedInput): 'generic' | 'github' | 'none' {
  if (resolveUpdateFeed(input)) return 'generic';
  return input.edition === 'open' ? 'github' : 'none';
}

/** Версия из `latest-mac.yml` (macOS без подписи сверяет версию, а не ставит обновление сам). */
export function versionFromLatestYml(text: string): string | null {
  const match = /^version:\s*['"]?([0-9][^'"\s]*)['"]?\s*$/m.exec(text);
  return match ? match[1] : null;
}
