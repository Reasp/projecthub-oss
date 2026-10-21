import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  ArrowLeftIcon,
  ArrowsClockwiseIcon,
  BookOpenTextIcon,
  CaretDownIcon,
  CaretRightIcon,
  CloudCheckIcon,
  CloudSlashIcon,
  FileTextIcon,
  GavelIcon,
  MagnifyingGlassIcon,
  WarningCircleIcon,
  XIcon
} from '@phosphor-icons/react';
import clsx from 'clsx';
import type { RemoteDocEntry } from '../../../src/types/remote';
import { buildDocTree, type DocTreeNode } from '../../../src/utils/docTree';
import { useServices, type AppServices } from '../app/context';
import { DocsController, isUnsupportedHostError, type DocView } from '../app/docsState';
import { Markdown } from '../components/Markdown';
import { Screen } from '../components/Screen';
import { Badge, Button, EmptyState, Spinner } from '../components/ui';
import { fieldProps } from '../components/FieldEditor';
import { getLanguage } from '../i18n';
import { useT } from '../i18n/react';
import { DocsCache } from '../protocol/docsCache';
import { docBodyForDisplay, filterDocs, headingKey, splitFrontmatter } from '../protocol/docsModel';
import { createDocsCacheStorage } from '../platform/docsCacheIdb';
import { DocBranchesPanel } from './DocBranchesPanel';

/**
 * Документация проекта (TASK-140.17): дерево разделов с документами и решениями, поиск по названию и id, чтение
 * документа с кэшем на телефоне. Логика загрузки и кэша — в `DocsController`, здесь только отображение.
 */

// ── контроллер на стор открытого приложения ──

const controllers = new WeakMap<object, DocsController>();
let sharedCache: DocsCache | null = null;

/** Последний проект хоста — чтобы без связи сразу после запуска открыть сохранённые документы. */
const PROJECT_PREF = 'ph_mobile_docs_project:';

function readPref(key: string): string {
  try {
    return globalThis.localStorage?.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writePref(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // хранилище страницы недоступно — без запоминания
  }
}

function controllerFor(services: AppServices): DocsController {
  const existing = controllers.get(services.store);
  if (existing) return existing;
  const { store, client } = services;
  // Запомненный проект по хосту: localStorage читается один раз, пишется только при смене проекта.
  const remembered = new Map<string, string>();
  const controller = new DocsController({
    request: (method, params) => store.request(method, params),
    context: () => {
      const s = store.getState();
      const hostId = s.conn.hostId || client.getProfile()?.hostId || s.status?.hostId || '';
      if (hostId && !remembered.has(hostId)) remembered.set(hostId, readPref(PROJECT_PREF + hostId));
      let projectPath = s.projectPath;
      if (hostId && projectPath && remembered.get(hostId) !== projectPath) {
        remembered.set(hostId, projectPath);
        writePref(PROJECT_PREF + hostId, projectPath);
      } else if (hostId && !projectPath) {
        // Без связи сразу после запуска стор ещё не знает проектов — берём последний открытый на этом хосте.
        projectPath = remembered.get(hostId) ?? '';
      }
      return { hostId, projectPath, online: s.conn.state === 'ready' };
    },
    subscribeContext: (listener) => store.subscribe(listener),
    cache: (sharedCache ??= new DocsCache(createDocsCacheStorage()))
  });
  controllers.set(store, controller);
  return controller;
}

function useDocs() {
  const services = useServices();
  const controller = controllerFor(services);
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  return { controller, state };
}

// Раскрытые разделы и строка поиска переживают переход на другую вкладку (экран при этом размонтируется).
const ui = { expanded: new Set<string>(['doc', 'decision']), query: '' };

function formatWhen(ts: number | null): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString(getLanguage() === 'ru' ? 'ru-RU' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
  }
}

// ── список ──

/** Запись списка в виде узла дерева `buildDocTree` (категория — вид записи). */
type TreeDoc = RemoteDocEntry & { category: RemoteDocEntry['kind'] };

function DocRow({ doc, cachedHash, onOpen, depth }: { doc: RemoteDocEntry; cachedHash: string | undefined; onOpen: () => void; depth: number }) {
  const tr = useT();
  const Icon = doc.kind === 'decision' ? GavelIcon : FileTextIcon;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-start gap-2 rounded-lg py-2 pr-2 text-left active:bg-ph-hover"
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      <Icon size={18} className="mt-0.5 shrink-0 text-slate-400" />
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] leading-snug">{doc.title}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500">
          <span className="font-mono">{doc.id}</span>
          {doc.kind === 'decision' && doc.status && <span>· {tr.docs.status[doc.status] ?? doc.status}</span>}
        </span>
      </span>
      {cachedHash !== undefined &&
        (cachedHash === doc.hash ? (
          <CloudCheckIcon size={16} className="mt-0.5 shrink-0 text-emerald-400/80" aria-label={tr.docs.availableOffline} />
        ) : (
          <ArrowsClockwiseIcon size={16} className="mt-0.5 shrink-0 text-amber-400/80" aria-label={tr.docs.changedOnComputer} />
        ))}
    </button>
  );
}

function TreeNode({
  node,
  depth,
  cachedHashes,
  expanded,
  onToggle,
  onOpen
}: {
  node: DocTreeNode<TreeDoc>;
  depth: number;
  cachedHashes: ReadonlyMap<string, string>;
  expanded: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onOpen: (doc: RemoteDocEntry) => void;
}) {
  if (node.kind === 'doc') return <DocRow doc={node.doc} cachedHash={cachedHashes.get(node.doc.path)} depth={depth} onOpen={() => onOpen(node.doc)} />;
  const open = expanded.has(node.key);
  const Caret = open ? CaretDownIcon : CaretRightIcon;
  return (
    <div>
      <button
        type="button"
        onClick={() => onToggle(node.key)}
        aria-expanded={open}
        className={clsx('flex w-full items-center gap-1.5 rounded-lg py-2 pr-2 text-left active:bg-ph-hover', depth === 0 ? 'text-[13px] font-semibold uppercase tracking-wide text-slate-400' : 'text-[14px] font-medium text-slate-200')}
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        <Caret size={14} className="shrink-0 text-slate-500" />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        <span className="text-[11px] font-normal text-slate-500">{node.count}</span>
      </button>
      {open &&
        node.children.map((child) => (
          <TreeNode key={child.key} node={child} depth={depth + 1} cachedHashes={cachedHashes} expanded={expanded} onToggle={onToggle} onOpen={onOpen} />
        ))}
    </div>
  );
}

function Notice({ tone, children }: { tone: 'warning' | 'danger' | 'neutral'; children: ReactNode }) {
  return (
    <div
      className={clsx(
        'mb-3 flex items-start gap-2 rounded-xl border px-3 py-2 text-[13px] leading-snug',
        tone === 'warning' && 'border-amber-500/40 bg-amber-950/40 text-amber-200',
        tone === 'danger' && 'border-red-500/40 bg-red-950/40 text-red-200',
        tone === 'neutral' && 'border-ph-line bg-ph-elevated text-slate-300'
      )}
    >
      {children}
    </div>
  );
}

function DocsList({ controller }: { controller: DocsController }) {
  const tr = useT();
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const [query, setQuery] = useState(ui.query);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(ui.expanded);
  // Ветки документации (decision-151) перечитываются вместе со списком по жесту обновления.
  const [branchesTick, setBranchesTick] = useState(0);

  useEffect(() => {
    ui.query = query;
  }, [query]);

  const toggle = (key: string) => {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    ui.expanded = next;
    setExpanded(next);
  };

  const tree = useMemo(
    () =>
      buildDocTree<TreeDoc>(
        state.docs.map((d) => ({ ...d, category: d.kind })),
        [
        { category: 'doc', name: tr.docs.documents },
        { category: 'decision', name: tr.docs.decisions }
        ]
      ),
    [state.docs, tr]
  );
  const found = useMemo(() => (query.trim() ? filterDocs(state.docs, query) : null), [state.docs, query]);
  const unsupported = isUnsupportedHostError(state.listError);

  return (
    <Screen
      onRefresh={() => {
        setBranchesTick((n) => n + 1);
        return controller.refreshList();
      }}
    >
      {state.projectPath && !state.listFromCache && <DocBranchesPanel projectPath={state.projectPath} refreshTick={branchesTick} />}
      <div className="relative mb-3">
        <MagnifyingGlassIcon size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          type="search"
          {...fieldProps({ value: query, onChange: setQuery, placeholder: tr.docs.search })}
          className="h-10 w-full rounded-xl border border-ph-line bg-ph-elevated pl-9 pr-9 text-[14px] outline-none focus:border-indigo-500"
        />
        {query && (
          <button
            type="button"
            aria-label={tr.docs.clearSearch}
            onClick={() => setQuery('')}
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full p-2 text-slate-400 active:bg-ph-hover"
          >
            <XIcon size={16} />
          </button>
        )}
      </div>

      {unsupported ? (
        <Notice tone="warning">
          <WarningCircleIcon size={18} className="shrink-0" />
          <span>{tr.docs.unsupportedHost}</span>
        </Notice>
      ) : state.listFromCache ? (
        <Notice tone="warning">
          <CloudSlashIcon size={18} className="shrink-0" />
          <span>{tr.docs.offlineList}</span>
        </Notice>
      ) : state.listError ? (
        <Notice tone="danger">
          <WarningCircleIcon size={18} className="shrink-0" />
          <span>
            {tr.docs.listError}: {state.listError}
          </span>
        </Notice>
      ) : null}

      {!state.loaded ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : state.docs.length === 0 ? (
        state.listFromCache || state.listError ? null : (
          <EmptyState icon={<BookOpenTextIcon size={40} />} title={tr.docs.emptyTitle} hint={tr.docs.emptyHint} />
        )
      ) : found ? (
        found.length === 0 ? (
          <EmptyState icon={<MagnifyingGlassIcon size={36} />} title={tr.docs.noMatches(query.trim())} />
        ) : (
          found.map((doc) => (
            <DocRow key={doc.path} doc={doc} depth={0} cachedHash={state.cachedHashes.get(doc.path)} onOpen={() => void controller.open(doc.path)} />
          ))
        )
      ) : (
        tree.map((root) => (
          <TreeNode
            key={root.key}
            node={root}
            depth={0}
            cachedHashes={state.cachedHashes}
            expanded={expanded}
            onToggle={toggle}
            onOpen={(doc) => void controller.open(doc.path)}
          />
        ))
      )}
    </Screen>
  );
}

// ── документ ──

function Freshness({ view }: { view: DocView }) {
  const tr = useT();
  switch (view.status) {
    case 'checking':
      return (
        <div className="flex items-center gap-2 text-[12px] text-slate-400">
          <Spinner className="h-3 w-3" /> {tr.docs.checking}
        </div>
      );
    case 'fresh':
      return (
        <div className="flex items-center gap-1.5 text-[12px] text-emerald-400/90">
          <CloudCheckIcon size={14} /> {tr.docs.fresh}
        </div>
      );
    case 'cached':
      return (
        <Notice tone="warning">
          <CloudSlashIcon size={18} className="shrink-0" />
          <span>{tr.docs.savedCopy(formatWhen(view.fetchedAt))}</span>
        </Notice>
      );
    default:
      return null;
  }
}

function DocReader({ controller, view }: { controller: DocsController; view: DocView }) {
  const tr = useT();
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const bodyRef = useRef<HTMLDivElement>(null);
  const fields = useMemo(() => (view.content ? splitFrontmatter(view.content).fields : {}), [view.content]);
  const title = view.entry?.title || fields.title || view.path.split('/').pop() || view.path;
  const id = view.entry?.id || fields.id || '';
  const kind = view.entry?.kind ?? (view.path.includes('/decisions/') ? 'decision' : 'doc');
  const date = view.entry?.date || fields.date || fields.created_date;
  const status = view.entry?.status || fields.status;
  const body = useMemo(() => (view.content ? docBodyForDisplay(view.content, title) : ''), [view.content, title]);

  // Прокрутка к заголовку из ссылки `[[id#Заголовок]]`, когда текст уже на экране.
  useEffect(() => {
    if (!view.anchor || !body || !bodyRef.current) return;
    const want = headingKey(view.anchor);
    const target = Array.from(bodyRef.current.querySelectorAll<HTMLElement>('[data-md-heading]')).find((el) => headingKey(el.textContent ?? '') === want);
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [view.anchor, view.anchorTick, body]);

  return (
    <Screen key={view.seq} onRefresh={() => controller.revalidate()}>
      <div className="mb-2 flex items-center gap-1">
        <Button size="sm" variant="ghost" className="-ml-2" onClick={() => controller.back()}>
          <ArrowLeftIcon size={16} /> {tr.common.back}
        </Button>
      </div>

      <div className="mb-3">
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
          <Badge tone={kind === 'decision' ? 'review' : 'accent'}>{tr.docs.kind[kind]}</Badge>
          {id && <span className="font-mono">{id}</span>}
          {status && <Badge>{tr.docs.status[status] ?? status}</Badge>}
          {date && <span>· {date}</span>}
        </div>
        <h1 className="mt-1.5 text-[19px] font-semibold leading-snug">{title}</h1>
        <div className="mt-1.5">
          <Freshness view={view} />
        </div>
      </div>

      {state.missingRef && (
        <button type="button" className="block w-full text-left" onClick={() => controller.dismissMissingRef()}>
          <Notice tone="neutral">
            <WarningCircleIcon size={18} className="shrink-0" />
            <span>{tr.docs.missingRef(state.missingRef)}</span>
          </Notice>
        </button>
      )}

      {view.content !== null ? (
        <div ref={bodyRef} className="text-[14.5px] leading-relaxed">
          <Markdown text={body} onDocLink={(refId, anchor) => void controller.openRef(refId, anchor)} />
        </div>
      ) : view.status === 'loading' ? (
        <div className="flex flex-col items-center gap-3 py-12 text-[13px] text-slate-400">
          <Spinner />
          {tr.docs.loading}
        </div>
      ) : view.status === 'unavailable' ? (
        <EmptyState icon={<CloudSlashIcon size={40} />} title={tr.docs.unavailableTitle} hint={tr.docs.unavailableHint} />
      ) : (
        <EmptyState
          icon={<WarningCircleIcon size={40} />}
          title={tr.docs.errorTitle}
          hint={
            <>
              {isUnsupportedHostError(view.error) ? tr.docs.unsupportedHost : view.error}
              <div className="mt-3">
                <Button size="sm" onClick={() => void controller.revalidate()}>
                  {tr.common.retry}
                </Button>
              </div>
            </>
          }
        />
      )}
    </Screen>
  );
}

export function DocsScreen() {
  const tr = useT();
  const { controller, state } = useDocs();
  const { scope, projectPath } = state;

  // Список — при первом показе и после смены ПК или проекта (контроллер тогда сбрасывает состояние).
  useEffect(() => {
    if (!state.loaded && !state.loading) void controller.refreshList();
  }, [controller, scope, state.loaded, state.loading]);

  if (!projectPath) return <EmptyState icon={<BookOpenTextIcon size={40} />} title={tr.common.noProject} />;
  const top = state.stack[state.stack.length - 1];
  if (top) return <DocReader controller={controller} view={top} />;
  return <DocsList controller={controller} />;
}
