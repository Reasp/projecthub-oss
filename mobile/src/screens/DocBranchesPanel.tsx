import { useCallback, useEffect, useMemo, useState } from 'react';
import { GitBranchIcon, WarningCircleIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import type { RemoteDocBranchDiff, RemoteDocBranchMerge, RemoteDocBranches } from '../../../src/types/remote';
import { collapseUnchanged, lineDiff } from '../../../src/lib/lineDiff';
import { useServices } from '../app/context';
import { useLanguage, useT } from '../i18n/react';
import { hostLabelText } from '../../../src/i18n/hostLabels';
import { Badge, Button, Card, Confirm, Sheet, Spinner } from '../components/ui';
import { errorText } from '../app/errorText';

/**
 * Ветки документации на телефоне (TASK-194, decision-151): правки агентов, которые ждут принятия. Лист ветки
 * показывает, что изменится в основной по каждому документу, конфликты разделов с выбором стороны и кнопки
 * «Принять» и «Отклонить». Решение пишется на ПК в аудит с устройством как источником.
 */

type Resolution = 'ours' | 'theirs' | 'both';
type Resolutions = Record<string, Record<string, Resolution>>;
type DiffFile = RemoteDocBranchDiff['files'][number];


function ResultDiff({ before, after }: { before: string; after: string }) {
  const ops = useMemo(() => lineDiff(before, after, 4000), [before, after]);
  if (!ops) return null;
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-ph-line bg-ph-base p-2 font-mono text-[11.5px] leading-snug">
      {collapseUnchanged(ops).map((row, i) =>
        row.op === 'gap' ? (
          <div key={i} className="select-none italic text-slate-600">
            … {row.count}
          </div>
        ) : (
          <div key={i} className={row.op === 'add' ? 'bg-emerald-500/10 text-emerald-300' : row.op === 'del' ? 'bg-rose-500/10 text-rose-300' : 'text-slate-500'}>
            {row.op === 'add' ? '+ ' : row.op === 'del' ? '− ' : '  '}
            {row.text}
          </div>
        )
      )}
    </pre>
  );
}

function FileBlock({
  file,
  chosen,
  onChoose,
  onAccept,
  busy
}: {
  file: DiffFile;
  chosen: Record<string, Resolution>;
  onChoose: (key: string, r: Resolution) => void;
  onAccept: () => void;
  busy: boolean;
}) {
  const tr = useT().docs.branches;
  const change = file.change === 'added' ? tr.added : file.change === 'removed' ? tr.removed : tr.modified;
  const unresolved = file.conflicts.filter((c) => !chosen[c.key]).length;
  return (
    <div className="mb-4 rounded-xl border border-ph-line bg-ph-elevated p-3">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
        <span className="font-mono">{file.docId}</span>
        <Badge>{change}</Badge>
        {file.mainChanged && <Badge tone="accent">{tr.mainChanged}</Badge>}
        {file.renumberedFrom && <Badge tone="warning">{tr.renumbered(file.renumberedFrom, file.docId)}</Badge>}
      </div>
      <div className="mt-1 text-[14px] font-medium leading-snug">{file.title}</div>
      {file.parts.length > 0 && (
        <div className="mt-1 text-[12px] text-slate-400">
          {tr.changed}: {file.parts.join('; ')}
        </div>
      )}

      <div className="mt-2">
        {file.conflicts.length > 0 ? (
          <div className="space-y-2">
            <div className="text-[12px] text-rose-200">{tr.conflictHint}</div>
            {file.conflicts.map((c) => (
              <div key={c.key} className="rounded-lg border border-rose-500/30 bg-rose-950/20 p-2">
                <div className="mb-1.5 text-[12px] font-medium text-rose-100">{c.label}</div>
                {(
                  [
                    ['ours', tr.ours, c.ours],
                    ['theirs', tr.theirs, c.theirs]
                  ] as const
                ).map(([key, label, text]) => (
                  <div key={key} className="mb-1.5">
                    <div className="text-[10.5px] text-slate-500">{label}</div>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-ph-line bg-ph-base p-1.5 font-mono text-[11px] text-slate-300">
                      {text ?? '—'}
                    </pre>
                  </div>
                ))}
                <div className="flex gap-1.5">
                  {(['ours', 'theirs', ...(c.ours !== null && c.theirs !== null ? (['both'] as const) : [])] as Resolution[]).map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => onChoose(c.key, r)}
                      className={clsx(
                        'h-8 flex-1 rounded-lg border text-[12.5px]',
                        chosen[c.key] === r ? 'border-indigo-400 bg-indigo-500/20 text-indigo-100' : 'border-ph-line text-slate-300 active:bg-ph-hover'
                      )}
                    >
                      {r === 'ours' ? tr.ours : r === 'theirs' ? tr.theirs : tr.both}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : file.merged === null ? (
          <div className="text-[12.5px] text-rose-300">{tr.willRemove}</div>
        ) : (file.main ?? '') === file.merged ? (
          <div className="text-[12.5px] text-slate-400">{tr.same}</div>
        ) : (
          <ResultDiff before={file.main ?? ''} after={file.merged} />
        )}
      </div>

      <Button size="sm" className="mt-2 w-full" disabled={busy || unresolved > 0} onClick={onAccept}>
        {tr.acceptDoc}
      </Button>
    </div>
  );
}

export function DocBranchesPanel({ projectPath, refreshTick }: { projectPath: string; refreshTick: number }) {
  const tr = useT().docs.branches;
  const language = useLanguage();
  const { store } = useServices();
  const [overview, setOverview] = useState<RemoteDocBranches | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [diff, setDiff] = useState<RemoteDocBranchDiff | null>(null);
  const [resolutions, setResolutions] = useState<Resolutions>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);

  const load = useCallback(async () => {
    try {
      setOverview((await store.request('get_doc_branches', { projectPath })) as RemoteDocBranches);
    } catch {
      // Старый ProjectHub на ПК без веток документации — блок просто не показывается.
      setOverview(null);
    }
  }, [store, projectPath]);

  useEffect(() => {
    void load();
  }, [load, refreshTick]);

  const loadDiff = async (id: string) => {
    try {
      setDiff((await store.request('get_doc_branch_diff', { projectPath, branchId: id })) as RemoteDocBranchDiff);
    } catch (err) {
      setMessage({ ok: false, text: tr.failed(errorText(err)) });
    }
  };

  const openBranch = async (id: string) => {
    setOpenId(id);
    setDiff(null);
    setResolutions({});
    setMessage(null);
    await loadDiff(id);
  };

  const accept = async (docs?: string[]) => {
    if (!openId) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = (await store.request('merge_doc_branch', { projectPath, branchId: openId, ...(docs ? { docs } : {}), resolutions })) as RemoteDocBranchMerge;
      if (result.status === 'conflict') setMessage({ ok: false, text: tr.conflictLeft(result.conflicts.length) });
      else if (result.status === 'nothing') setMessage({ ok: true, text: tr.nothing });
      else setMessage({ ok: true, text: result.status === 'merged' ? tr.merged : tr.partial });
      await load();
      if (result.status === 'merged') setDiff(null);
      else await loadDiff(openId);
    } catch (err) {
      setMessage({ ok: false, text: tr.failed(errorText(err)) });
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!openId) return;
    setConfirmReject(false);
    setBusy(true);
    try {
      await store.request('close_doc_branch', { projectPath, branchId: openId });
      setOpenId(null);
      await load();
    } catch (err) {
      setMessage({ ok: false, text: tr.failed(errorText(err)) });
    } finally {
      setBusy(false);
    }
  };

  if (!overview?.available || overview.branches.length === 0) return null;
  const unresolvedAll = diff ? diff.files.reduce((n, f) => n + f.conflicts.filter((c) => !resolutions[f.docId]?.[c.key]).length, 0) : 0;

  return (
    <div className="mb-3" data-testid="doc-branches">
      <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[13px] font-semibold uppercase tracking-wide text-slate-400">
        <GitBranchIcon size={15} /> {tr.title}
      </div>
      {overview.branches.map((br) => (
        <Card key={br.id} className="mb-2" onClick={() => void openBranch(br.id)}>
          <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <span className="font-mono">{br.id}</span>
            <Badge tone={br.status === 'proposed' ? 'warning' : 'neutral'}>{br.status === 'proposed' ? tr.proposed : tr.open}</Badge>
            {br.conflicts > 0 && <WarningCircleIcon size={14} className="text-rose-400" />}
          </div>
          <div className="mt-1 text-[14px] leading-snug">{br.title}</div>
          <div className="mt-0.5 text-[11.5px] text-slate-500">
            {[br.author ? hostLabelText(br.author, language) : '', br.task, tr.docs(br.docs.length), br.conflicts ? tr.conflicts(br.conflicts) : ''].filter(Boolean).join(' · ')}
          </div>
        </Card>
      ))}

      <Sheet
        open={openId !== null}
        onClose={() => setOpenId(null)}
        title={diff ? `${diff.branch.id} · ${diff.branch.title}` : openId ?? ''}
        footer={
          diff && diff.files.length > 0 ? (
            <div className="flex gap-2">
              <Button className="flex-1" variant="danger" disabled={busy} onClick={() => setConfirmReject(true)}>
                {tr.reject}
              </Button>
              <Button className="flex-1" variant="primary" disabled={busy || unresolvedAll > 0} onClick={() => void accept()}>
                {tr.acceptAll}
              </Button>
            </div>
          ) : undefined
        }
      >
        {message && <div className={clsx('mb-3 rounded-lg px-3 py-2 text-[13px]', message.ok ? 'bg-emerald-950/40 text-emerald-200' : 'bg-red-950/40 text-red-200')}>{message.text}</div>}
        {!diff ? (
          <div className="flex justify-center py-8">{openId && !message && <Spinner />}</div>
        ) : (
          <>
            {diff.branch.proposal && <p className="mb-3 whitespace-pre-wrap text-[13px] text-slate-300">{diff.branch.proposal}</p>}
            {diff.files.map((f) => (
              <FileBlock
                key={f.path}
                file={f}
                busy={busy}
                chosen={resolutions[f.docId] ?? {}}
                onChoose={(key, r) => setResolutions((prev) => ({ ...prev, [f.docId]: { ...(prev[f.docId] ?? {}), [key]: r } }))}
                onAccept={() => void accept([f.docId])}
              />
            ))}
          </>
        )}
      </Sheet>
      <Confirm open={confirmReject} title={tr.reject} body={tr.rejectConfirm} confirmText={tr.reject} danger onConfirm={() => void reject()} onCancel={() => setConfirmReject(false)} />
    </div>
  );
}
