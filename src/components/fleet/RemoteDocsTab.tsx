import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, FileText, Loader2, Search } from '../common/icons';
import { MarkdownViewer } from '../common/MarkdownViewer';
import { ipcErrorText, useTranslation } from '../../i18n/useTranslation';
import { docBodyForDisplay, filterDocs, groupDocsBySection } from '../../utils/remoteDocs';
import type { DocRefNavigation } from '../../hooks/useDocRefs';
import type { RemoteDocContent, RemoteDocEntry } from '../../types/remote';
import type { RemoteCall } from './RemoteProjectView';

/**
 * Вкладка «Документация» проекта удалённого ПК (TASK-229): документы и решения по разделам слева, документ справа.
 * Текст запрашивается с хэшем уже прочитанного: неизменённый документ хост не пересылает.
 */

function fmt(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

interface Props {
  docs: RemoteDocEntry[] | null;
  error: string | null;
  call: RemoteCall;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  refs: DocRefNavigation;
  reloadTick: number;
}

export const RemoteDocsTab: React.FC<Props> = ({ docs, error, call, selectedPath, onSelect, refs, reloadTick }) => {
  const { t } = useTranslation();
  const td = t.fleet.project.docs;
  const [query, setQuery] = useState('');
  const [content, setContent] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const cache = useRef(new Map<string, { hash: string; content: string }>());

  const sections = useMemo(() => groupDocsBySection(filterDocs(docs ?? [], query)), [docs, query]);
  const selected = docs?.find((d) => d.path === selectedPath) ?? null;

  useEffect(() => {
    if (!selectedPath) return;
    let cancelled = false;
    const known = cache.current.get(selectedPath);
    setContent(known?.content ?? null);
    setDocError(null);
    call<RemoteDocContent>('get_doc', { path: selectedPath, ...(known ? { knownHash: known.hash } : {}) })
      .then((res) => {
        if (cancelled) return;
        if (res.unchanged) {
          setContent(cache.current.get(selectedPath)?.content ?? '');
          return;
        }
        cache.current.set(selectedPath, { hash: res.hash, content: res.content });
        setContent(res.content);
      })
      .catch((err) => {
        if (!cancelled) setDocError(ipcErrorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [call, selectedPath, reloadTick]);

  return (
    <div className="h-full flex min-h-0">
      <div className="w-80 shrink-0 border-r border-ph-line flex flex-col min-h-0">
        <div className="p-2 shrink-0">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2 top-1/2 -translate-y-1/2" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={td.search}
              className="w-full h-7 pl-7 pr-2 rounded-md bg-ph-raised text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none"
            />
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto pb-2">
          {error && <div className="px-3 text-xs text-rose-300">{fmt(t.fleet.project.loadError, { error })}</div>}
          {!docs && !error && <Loader2 className="mx-3 w-4 h-4 animate-spin text-slate-500" />}
          {docs && sections.length === 0 && <div className="px-3 text-xs text-slate-500">{td.empty}</div>}
          {sections.map((group) => (
            <div key={group.section || '-'} className="mb-1">
              <div className="px-3 pt-2 pb-0.5 text-[10px] uppercase tracking-wide text-slate-500 truncate">{group.section || td.noSection}</div>
              {group.docs.map((doc) => {
                const Icon = doc.kind === 'decision' ? BookOpen : FileText;
                return (
                  <button
                    key={doc.path}
                    type="button"
                    onClick={() => onSelect(doc.path)}
                    title={doc.path}
                    className={`w-full text-left px-3 py-1 flex items-center gap-1.5 ${doc.path === selectedPath ? 'bg-indigo-500/15' : 'hover:bg-ph-hover'}`}
                    data-testid={`remote-doc-${doc.id}`}
                  >
                    <Icon className={`w-3.5 h-3.5 shrink-0 ${doc.kind === 'decision' ? 'text-cyan-400' : 'text-slate-400'}`} />
                    <span className="shrink-0 text-[10px] text-slate-500">{doc.id}</span>
                    <span className="truncate text-xs text-slate-200 flex-1">{doc.title}</span>
                    {doc.status && <span className="shrink-0 text-[10px] text-slate-500">{doc.status}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 min-w-0 overflow-y-auto">
        {!selectedPath && <div className="p-6 text-xs text-slate-500">{td.pick}</div>}
        {selectedPath && (
          <div className="max-w-4xl mx-auto p-6" data-testid="remote-doc-view">
            {selected && (
              <div className="mb-4">
                <div className="text-[11px] text-slate-500">
                  {selected.id}
                  {selected.kind === 'decision' ? ` · ${td.decision}` : ''}
                  {selected.status ? ` · ${selected.status}` : ''}
                  {selected.date ? ` · ${selected.date}` : ''}
                </div>
                <h1 className="text-xl font-semibold text-slate-100">{selected.title}</h1>
              </div>
            )}
            {docError && <div className="text-xs text-rose-300">{fmt(t.fleet.project.loadError, { error: docError })}</div>}
            {content === null && !docError && <Loader2 className="w-4 h-4 animate-spin text-slate-500" />}
            {content !== null && <MarkdownViewer content={docBodyForDisplay(content, selected?.title)} refs={refs} />}
          </div>
        )}
      </div>
    </div>
  );
};
