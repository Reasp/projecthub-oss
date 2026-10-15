import { useEffect, useRef, useState } from 'react';
import { PaperPlaneRightIcon, PlusIcon, SparkleIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useAppState, useServices } from '../app/context';
import { Button, EmptyState, Spinner } from '../components/ui';
import { capabilitiesFor } from '../protocol/models';

/**
 * Промпт в AI Studio на ПК: агент и модель — из настроек ProjectHub на хосте, в приложении своих
 * моделей нет. Ответ приходит потоком `ai:chunk` по `sessionId`.
 */
export function StudioScreen() {
  const { store } = useServices();
  const studio = useAppState((s) => s.studio);
  const projectPath = useAppState((s) => s.projectPath);
  const conn = useAppState((s) => s.conn);
  const canWrite = capabilitiesFor(conn.rights, conn.readOnly).write;
  const [text, setText] = useState('');
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [studio.messages]);

  const send = async () => {
    const value = text;
    setText('');
    const ok = await store.sendPrompt(value);
    if (!ok) setText(value);
  };

  if (!projectPath) return <EmptyState icon={<SparkleIcon size={40} />} title="Проект не выбран" />;

  return (
    <div className="flex h-full flex-col">
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-3 pt-3">
        {studio.messages.length === 0 ? (
          <EmptyState
            icon={<SparkleIcon size={40} />}
            title="Промпт агенту на ПК"
            hint="Агент работает в проекте на компьютере с теми же настройками, ролями и подтверждениями, что и в AI Studio."
          />
        ) : (
          studio.messages.map((m) => (
            <div key={m.id} className={clsx('mb-2 flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
              <div
                className={clsx(
                  'selectable max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-[14px] leading-relaxed',
                  m.role === 'user' && 'rounded-br-md bg-indigo-500 text-white',
                  m.role === 'assistant' && 'rounded-bl-md bg-ph-elevated text-slate-100',
                  m.role === 'error' && 'bg-red-950/70 text-red-200'
                )}
              >
                {m.text}
              </div>
            </div>
          ))
        )}
        {studio.busy && (
          <div className="mb-3 flex items-center gap-2 px-1 text-[13px] text-slate-400">
            <Spinner className="h-3 w-3" /> Агент работает…
          </div>
        )}
      </div>
      {canWrite ? (
        <div className="flex items-end gap-2 border-t border-ph-line bg-ph-chrome px-3 py-2">
          {studio.messages.length > 0 && (
            <button type="button" aria-label="Новая сессия" onClick={() => store.newStudioSession()} className="mb-1 rounded-full p-2 text-slate-400 active:bg-ph-hover">
              <PlusIcon size={20} />
            </button>
          )}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={1}
            placeholder="Что сделать?"
            className="max-h-32 min-h-[44px] flex-1 resize-none rounded-2xl border border-ph-line bg-ph-raised px-3 py-2.5 text-[15px] outline-none focus:border-indigo-500"
          />
          <Button variant="primary" className="h-11 w-11 shrink-0 rounded-full !px-0" disabled={!text.trim()} haptic="medium" aria-label="Отправить" onClick={send}>
            <PaperPlaneRightIcon size={20} weight="fill" />
          </Button>
        </div>
      ) : (
        <div className="border-t border-ph-line px-3 py-3 text-center text-[13px] text-slate-400">Отправлять промпты с этого устройства нельзя.</div>
      )}
    </div>
  );
}
