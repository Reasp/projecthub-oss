/**
 * Кэш документации на телефоне (TASK-140.17). Запись — текст документа одного ПК, проекта и пути вместе с хэшем, который
 * отдал ПК: при следующем открытии текст показывается сразу, а `get_doc` с этим хэшем отвечает «не изменился» без
 * пересылки. Объём ограничен — вытесняются давно не открытые записи (LRU).
 *
 * Модуль без DOM: хранилище подставляется портом (`DocsCacheStorage`) — IndexedDB в приложении, память в тестах и там,
 * где IndexedDB нет. Ошибка хранилища не роняет экран: кэш тогда ведёт себя как пустой. Секретов здесь нет — только
 * тексты документации проекта.
 */

/** Запись без текста: по ним считаются объём и порядок вытеснения, не читая сами тексты. */
export interface DocsCacheMeta {
  key: string;
  hostId: string;
  projectPath: string;
  /** Путь документа от корня проекта; `LIST_PATH` — список документов проекта для работы без связи. */
  path: string;
  hash: string;
  /** Когда ПК последний раз подтвердил, что текст актуален (получен или «не изменился»). */
  fetchedAt: number;
  /** Последнее открытие — для вытеснения давно не открытых. */
  usedAt: number;
  /** Размер текста в байтах UTF-8. */
  bytes: number;
}

export interface DocsCacheStorage {
  listMeta(): Promise<DocsCacheMeta[]>;
  getContent(key: string): Promise<string | null>;
  put(meta: DocsCacheMeta, content: string): Promise<void>;
  putMeta(meta: DocsCacheMeta): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface DocsCacheLimits {
  maxBytes: number;
  maxEntries: number;
}

export const DEFAULT_DOCS_CACHE_LIMITS: DocsCacheLimits = { maxBytes: 5 * 1024 * 1024, maxEntries: 400 };

/** Служебный путь записи со списком документов проекта (у настоящих путей всегда есть `backlog/`). */
export const LIST_PATH = '#list';

export interface CachedDoc {
  hash: string;
  content: string;
  fetchedAt: number;
}

export function docsCacheKey(hostId: string, projectPath: string, path: string): string {
  return `${hostId}\u0000${projectPath}\u0000${path}`;
}

export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4; // суррогатная пара — один символ из 4 байт
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Какие записи вытеснить, чтобы уложиться в лимиты: сначала давно не открытые. `keep` — только что записанная,
 * её не трогаем (если она одна больше лимита, её не пишут вовсе — см. `DocsCache.put`).
 */
export function planEviction(metas: readonly DocsCacheMeta[], limits: DocsCacheLimits, keep?: string): string[] {
  let total = metas.reduce((sum, m) => sum + m.bytes, 0);
  let count = metas.length;
  if (total <= limits.maxBytes && count <= limits.maxEntries) return [];
  const order = metas.filter((m) => m.key !== keep).sort((a, b) => a.usedAt - b.usedAt || a.fetchedAt - b.fetchedAt);
  const evict: string[] = [];
  for (const m of order) {
    if (total <= limits.maxBytes && count <= limits.maxEntries) break;
    evict.push(m.key);
    total -= m.bytes;
    count -= 1;
  }
  return evict;
}

/** Хранилище в памяти: запасной вариант без IndexedDB и для тестов. */
export function memoryDocsStorage(): DocsCacheStorage {
  const metas = new Map<string, DocsCacheMeta>();
  const bodies = new Map<string, string>();
  return {
    listMeta: async () => [...metas.values()].map((m) => ({ ...m })),
    getContent: async (key) => bodies.get(key) ?? null,
    put: async (meta, content) => {
      metas.set(meta.key, { ...meta });
      bodies.set(meta.key, content);
    },
    putMeta: async (meta) => {
      if (metas.has(meta.key)) metas.set(meta.key, { ...meta });
    },
    remove: async (keys) => {
      for (const k of keys) {
        metas.delete(k);
        bodies.delete(k);
      }
    }
  };
}

export class DocsCache {
  private metas: Map<string, DocsCacheMeta> | null = null;
  private loading: Promise<Map<string, DocsCacheMeta>> | null = null;

  constructor(
    private readonly storage: DocsCacheStorage,
    private readonly limits: DocsCacheLimits = DEFAULT_DOCS_CACHE_LIMITS,
    private readonly now: () => number = Date.now
  ) {}

  private index(): Promise<Map<string, DocsCacheMeta>> {
    if (this.metas) return Promise.resolve(this.metas);
    if (!this.loading) {
      this.loading = this.storage
        .listMeta()
        .catch(() => [] as DocsCacheMeta[])
        .then((list) => {
          this.metas = new Map(list.map((m) => [m.key, m]));
          return this.metas;
        });
    }
    return this.loading;
  }

  /** Текст из кэша или `null`; открытие отмечается для вытеснения. */
  async get(hostId: string, projectPath: string, path: string): Promise<CachedDoc | null> {
    const metas = await this.index();
    const key = docsCacheKey(hostId, projectPath, path);
    const meta = metas.get(key);
    if (!meta) return null;
    let content: string | null;
    try {
      content = await this.storage.getContent(key);
    } catch {
      content = null;
    }
    if (content === null) {
      // Текст пропал (хранилище очищено системой) — убираем и запись о нём.
      metas.delete(key);
      await this.storage.remove([key]).catch(() => undefined);
      return null;
    }
    const used = { ...meta, usedAt: this.now() };
    metas.set(key, used);
    await this.storage.putMeta(used).catch(() => undefined);
    return { hash: meta.hash, content, fetchedAt: meta.fetchedAt };
  }

  /** Записать текст с хэшем ПК. `false` — текст больше всего кэша и не сохранён. */
  async put(hostId: string, projectPath: string, path: string, hash: string, content: string): Promise<boolean> {
    const metas = await this.index();
    const bytes = utf8Bytes(content);
    if (bytes > this.limits.maxBytes) return false;
    const now = this.now();
    const key = docsCacheKey(hostId, projectPath, path);
    const meta: DocsCacheMeta = { key, hostId, projectPath, path, hash, fetchedAt: now, usedAt: now, bytes };
    try {
      await this.storage.put(meta, content);
    } catch {
      return false;
    }
    metas.set(key, meta);
    const evict = planEviction([...metas.values()], this.limits, key);
    if (evict.length > 0) {
      for (const k of evict) metas.delete(k);
      await this.storage.remove(evict).catch(() => undefined);
    }
    return true;
  }

  /** ПК ответил «не изменился»: текст снова подтверждён. */
  async markFresh(hostId: string, projectPath: string, path: string): Promise<void> {
    const metas = await this.index();
    const key = docsCacheKey(hostId, projectPath, path);
    const meta = metas.get(key);
    if (!meta) return;
    const now = this.now();
    const next = { ...meta, fetchedAt: now, usedAt: now };
    metas.set(key, next);
    await this.storage.putMeta(next).catch(() => undefined);
  }

  /** Хэши закэшированных документов проекта по пути — значки «есть без связи» и «изменился на ПК» в списке. */
  async hashes(hostId: string, projectPath: string): Promise<Map<string, string>> {
    const metas = await this.index();
    const out = new Map<string, string>();
    for (const m of metas.values()) {
      if (m.hostId === hostId && m.projectPath === projectPath && m.path !== LIST_PATH) out.set(m.path, m.hash);
    }
    return out;
  }

  /** Сколько занимает кэш сейчас. */
  async usage(): Promise<{ bytes: number; entries: number }> {
    const metas = await this.index();
    let bytes = 0;
    for (const m of metas.values()) bytes += m.bytes;
    return { bytes, entries: metas.size };
  }
}
