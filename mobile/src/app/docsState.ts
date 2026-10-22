import type { RemoteDocContent, RemoteDocEntry, RemoteDocsList } from '../../../src/types/remote';
import { DocsCache, LIST_PATH } from '../protocol/docsCache';
import type { RpcMethod } from '../protocol/remoteClient';
import { errorText } from './errorText';

/**
 * Документация проекта на телефоне (TASK-140.17): список с ПК без текстов, текст — при открытии, кэш со сверкой хэша.
 * Без React: экран читает состояние через `subscribe`/`getState`, логика проверяется unit-тестами с поддельным ПК.
 *
 * Порядок открытия: кэш показывается сразу → `get_doc` с `knownHash` → «не изменился» отмечает кэш свежим, новый
 * текст заменяет его. Без связи остаётся кэш с пометкой «может быть устаревшим»; без кэша — понятное сообщение.
 */

export interface DocsContext {
  hostId: string;
  projectPath: string;
  online: boolean;
}

export interface DocsDeps {
  request<T = unknown>(method: RpcMethod, params: Record<string, unknown>): Promise<T>;
  context(): DocsContext;
  /** Изменения хоста, проекта или связи. */
  subscribeContext(listener: () => void): () => void;
  cache: DocsCache;
  now?: () => number;
}

/**
 * - `loading` — текста ещё нет, ждём ПК;
 * - `checking` — показан кэш, ПК сверяет версию;
 * - `fresh` — текст подтверждён ПК;
 * - `cached` — показан кэш, ПК недоступен: версия может быть устаревшей;
 * - `unavailable` — нет ни кэша, ни связи;
 * - `error` — ПК ответил ошибкой, кэша нет.
 */
export type DocViewStatus = 'loading' | 'checking' | 'fresh' | 'cached' | 'unavailable' | 'error';

export interface DocView {
  seq: number;
  path: string;
  entry: RemoteDocEntry | null;
  /** Текст файла целиком, с frontmatter. */
  content: string | null;
  hash: string | null;
  status: DocViewStatus;
  /** Когда ПК последний раз подтвердил текст. */
  fetchedAt: number | null;
  /** Текст ошибки ПК (как пришёл), если была. */
  error: string | null;
  /** Заголовок, к которому прокрутить (`[[decision-46#Decision]]`). */
  anchor?: string;
  /** Растёт при повторном переходе к якорю в том же документе — экран прокручивает снова. */
  anchorTick?: number;
}

export interface DocsState {
  /** Хост и проект, к которым относится состояние. */
  scope: string;
  projectPath: string;
  docs: RemoteDocEntry[];
  loaded: boolean;
  loading: boolean;
  /** Список из кэша: ПК недоступен, документы могли измениться. */
  listFromCache: boolean;
  listError: string | null;
  /** Хэши закэшированных документов по пути: значок «есть без связи», расхождение — «изменился на ПК». */
  cachedHashes: ReadonlyMap<string, string>;
  /** Открытые документы: последний на экране, «Назад» возвращает к предыдущему. */
  stack: DocView[];
  /** Ссылка вела на документ, которого нет в списке. */
  missingRef: string | null;
}

function scopeOf(ctx: DocsContext): string {
  return `${ctx.hostId}\u0000${ctx.projectPath}`;
}

/** Хост до TASK-140.17 не знает методов документации. */
export function isUnsupportedHostError(text: string | null | undefined): boolean {
  return Boolean(text && /Unknown RPC method: get_doc/.test(text));
}

function parseCachedList(text: string): RemoteDocEntry[] | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (!Array.isArray(value)) return null;
    return value.filter(
      (d): d is RemoteDocEntry =>
        Boolean(d) && typeof d === 'object' && typeof d.path === 'string' && typeof d.id === 'string' && typeof d.title === 'string'
    );
  } catch {
    return null;
  }
}

export class DocsController {
  private state: DocsState;
  private listeners = new Set<() => void>();
  private seq = 0;
  private lastOnline: boolean;
  private readonly unsubscribe: () => void;
  private readonly now: () => number;

  constructor(private readonly deps: DocsDeps) {
    this.now = deps.now ?? Date.now;
    const ctx = deps.context();
    this.lastOnline = ctx.online;
    this.state = DocsController.empty(ctx);
    this.unsubscribe = deps.subscribeContext(() => this.onContext());
  }

  private static empty(ctx: DocsContext): DocsState {
    return {
      scope: scopeOf(ctx),
      projectPath: ctx.projectPath,
      docs: [],
      loaded: false,
      loading: false,
      listFromCache: false,
      listError: null,
      cachedHashes: new Map(),
      stack: [],
      missingRef: null
    };
  }

  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  getState = (): DocsState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<DocsState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private updateView(seq: number, patch: Partial<DocView>): void {
    if (!this.state.stack.some((v) => v.seq === seq)) return;
    this.set({ stack: this.state.stack.map((v) => (v.seq === seq ? { ...v, ...patch } : v)) });
  }

  /** Другой ПК или проект — прежний список не должен мелькнуть; связь вернулась — сверить показанное из кэша. */
  private onContext(): void {
    const ctx = this.deps.context();
    const scope = scopeOf(ctx);
    const cameOnline = ctx.online && !this.lastOnline;
    this.lastOnline = ctx.online;
    if (scope !== this.state.scope) {
      this.state = DocsController.empty(ctx);
      for (const l of this.listeners) l();
      return;
    }
    if (!cameOnline || !this.state.loaded) return;
    if (this.state.listFromCache || this.state.listError) void this.refreshList();
    const top = this.current();
    if (top && (top.status === 'cached' || top.status === 'unavailable' || top.status === 'error')) void this.revalidate();
  }

  current(): DocView | null {
    return this.state.stack[this.state.stack.length - 1] ?? null;
  }

  private async refreshHashes(ctx: DocsContext): Promise<void> {
    const hashes = await this.deps.cache.hashes(ctx.hostId, ctx.projectPath);
    if (scopeOf(this.deps.context()) === scopeOf(ctx)) this.set({ cachedHashes: hashes });
  }

  /** Список документов: сначала из кэша (если ещё ничего не показано), затем с ПК. */
  async refreshList(): Promise<void> {
    const ctx = this.deps.context();
    const scope = scopeOf(ctx);
    if (scope !== this.state.scope) {
      this.state = DocsController.empty(ctx);
    }
    if (!ctx.projectPath) {
      this.set({ docs: [], loaded: true, loading: false, listFromCache: false, listError: null });
      return;
    }
    const { cache } = this.deps;
    this.set({ loading: true });
    if (!this.state.loaded) {
      const cached = await cache.get(ctx.hostId, ctx.projectPath, LIST_PATH);
      const docs = cached ? parseCachedList(cached.content) : null;
      if (scope !== this.state.scope) return;
      if (docs) this.set({ docs, loaded: true, listFromCache: true });
    }
    await this.refreshHashes(ctx);
    if (!ctx.online) {
      if (scope === this.state.scope) this.set({ loaded: true, loading: false, listFromCache: this.state.docs.length > 0 });
      return;
    }
    try {
      const res = await this.deps.request<RemoteDocsList>('get_docs', { projectPath: ctx.projectPath });
      if (scope !== this.state.scope) return;
      const docs = Array.isArray(res?.docs) ? res.docs : [];
      this.set({ docs, loaded: true, loading: false, listFromCache: false, listError: null });
      await cache.put(ctx.hostId, ctx.projectPath, LIST_PATH, '', JSON.stringify(docs));
    } catch (err) {
      if (scope !== this.state.scope) return;
      this.set({ loaded: true, loading: false, listError: errorText(err), listFromCache: this.state.docs.length > 0 });
    }
  }

  /** Открыть документ по пути из списка. */
  async open(path: string, anchor?: string): Promise<void> {
    const ctx = this.deps.context();
    const entry = this.state.docs.find((d) => d.path === path) ?? null;
    const view: DocView = {
      seq: ++this.seq,
      path,
      entry,
      content: null,
      hash: null,
      status: 'loading',
      fetchedAt: null,
      error: null,
      ...(anchor ? { anchor } : {})
    };
    this.set({ stack: [...this.state.stack, view], missingRef: null });
    await this.load(view.seq, ctx);
  }

  /** Ссылка `[[decision-46]]` из текста: документ из списка этого проекта. */
  async openRef(id: string, anchor?: string): Promise<boolean> {
    const key = id.trim().toLowerCase();
    const entry = this.state.docs.find((d) => d.id.toLowerCase() === key);
    if (!entry) {
      this.set({ missingRef: id });
      return false;
    }
    const top = this.current();
    // Ссылка на раздел того же документа — только прокрутка.
    if (top && top.path === entry.path) {
      this.updateView(top.seq, { anchor, anchorTick: (top.anchorTick ?? 0) + 1 });
      return true;
    }
    await this.open(entry.path, anchor);
    return true;
  }

  dismissMissingRef(): void {
    if (this.state.missingRef) this.set({ missingRef: null });
  }

  back(): void {
    if (this.state.stack.length === 0) return;
    this.set({ stack: this.state.stack.slice(0, -1) });
  }

  closeAll(): void {
    if (this.state.stack.length > 0) this.set({ stack: [] });
  }

  /** Сверить открытый документ с ПК ещё раз («потянуть для обновления», связь вернулась). */
  async revalidate(): Promise<void> {
    const top = this.current();
    if (!top) return;
    await this.load(top.seq, this.deps.context());
  }

  private async load(seq: number, ctx: DocsContext): Promise<void> {
    const view = this.state.stack.find((v) => v.seq === seq);
    if (!view) return;
    const { cache } = this.deps;
    const cached = await cache.get(ctx.hostId, ctx.projectPath, view.path);
    if (cached) {
      this.updateView(seq, {
        content: cached.content,
        hash: cached.hash,
        fetchedAt: cached.fetchedAt,
        status: ctx.online ? 'checking' : 'cached',
        error: null
      });
    } else if (view.content === null) {
      this.updateView(seq, { status: ctx.online ? 'loading' : 'unavailable' });
    }
    if (!ctx.online) {
      if (!cached && view.content !== null) this.updateView(seq, { status: 'cached' });
      return;
    }

    const knownHash = cached?.hash ?? view.hash ?? undefined;
    let res: RemoteDocContent;
    try {
      res = await this.deps.request<RemoteDocContent>('get_doc', {
        projectPath: ctx.projectPath,
        path: view.path,
        ...(knownHash ? { knownHash } : {})
      });
    } catch (err) {
      const shown = this.state.stack.find((v) => v.seq === seq);
      this.updateView(seq, { status: shown?.content !== null && shown?.content !== undefined ? 'cached' : 'error', error: errorText(err) });
      return;
    }
    if (scopeOf(this.deps.context()) !== scopeOf(ctx)) return;

    if (res.unchanged === true) {
      const shown = this.state.stack.find((v) => v.seq === seq);
      if (!shown || shown.content === null) {
        // ПК счёл кэш актуальным, но текста нет (кэш вытеснен между запросами) — просим текст целиком.
        this.updateView(seq, { hash: null });
        await this.reloadWithoutHash(seq, ctx);
        return;
      }
      await cache.markFresh(ctx.hostId, ctx.projectPath, view.path);
      this.updateView(seq, { status: 'fresh', fetchedAt: this.now(), error: null });
      return;
    }
    if (typeof res.content !== 'string') {
      this.updateView(seq, { status: 'error', error: 'Malformed response' });
      return;
    }
    this.updateView(seq, { content: res.content, hash: res.hash, status: 'fresh', fetchedAt: this.now(), error: null });
    await cache.put(ctx.hostId, ctx.projectPath, view.path, res.hash, res.content);
    // Список мог отстать от файла: хэш записи списка подтягиваем к прочитанному.
    if (this.state.docs.some((d) => d.path === view.path && d.hash !== res.hash)) {
      this.set({ docs: this.state.docs.map((d) => (d.path === view.path ? { ...d, hash: res.hash } : d)) });
    }
    await this.refreshHashes(ctx);
  }

  private async reloadWithoutHash(seq: number, ctx: DocsContext): Promise<void> {
    const view = this.state.stack.find((v) => v.seq === seq);
    if (!view) return;
    try {
      const res = await this.deps.request<RemoteDocContent>('get_doc', { projectPath: ctx.projectPath, path: view.path });
      if (res.unchanged === true || typeof res.content !== 'string') throw new Error('Malformed response');
      this.updateView(seq, { content: res.content, hash: res.hash, status: 'fresh', fetchedAt: this.now(), error: null });
      await this.deps.cache.put(ctx.hostId, ctx.projectPath, view.path, res.hash, res.content);
      await this.refreshHashes(ctx);
    } catch (err) {
      this.updateView(seq, { status: 'error', error: errorText(err) });
    }
  }
}
