import React, { useEffect, useState } from 'react';
import { Save } from '../../common/icons';
import { useTranslation } from '../../../i18n';
import type { AgentTaskSettings } from '../../../types/electron';

/** Границы, как в `AGENT_TASK_LIMIT_BOUNDS` main-процесса: main всё равно приводит значение к ним. */
const BOUNDS = { perSession: { min: 1, max: 200 }, perProjectPerDay: { min: 1, max: 1000 } } as const;

/**
 * Лимиты задач, которые агенты заводят через `task_create` (TASK-155, decision-89 п. 6). Общие для всех ролей
 * и проектов и хранятся в userData: файлы проекта агент мог бы переписать сам.
 */
export const AgentTaskLimitsPanel: React.FC = () => {
  const { t } = useTranslation();
  const l = t.roles.agentTaskLimits;
  const [saved, setSaved] = useState<AgentTaskSettings | null>(null);
  const [perSession, setPerSession] = useState('');
  const [perDay, setPerDay] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    let alive = true;
    window.api
      .getAgentTaskSettings()
      .then((s) => {
        if (!alive) return;
        setSaved(s);
        setPerSession(String(s.limits.perSession));
        setPerDay(String(s.limits.perProjectPerDay));
      })
      .catch(() => setStatus('error'));
    return () => {
      alive = false;
    };
  }, []);

  const dirty = saved !== null && (perSession !== String(saved.limits.perSession) || perDay !== String(saved.limits.perProjectPerDay));

  const save = async () => {
    setStatus('saving');
    try {
      const next = await window.api.saveAgentTaskSettings({ limits: { perSession: Number(perSession), perProjectPerDay: Number(perDay) } });
      setSaved(next);
      setPerSession(String(next.limits.perSession));
      setPerDay(String(next.limits.perProjectPerDay));
      setStatus('saved');
    } catch {
      setStatus('error');
    }
  };

  const field = (label: string, hint: string, value: string, onChange: (v: string) => void, bounds: { min: number; max: number }, testId: string) => (
    <label className="block">
      <span className="text-[11px] font-medium text-muted-foreground block mb-1">{label}</span>
      <input
        type="number"
        data-testid={testId}
        min={bounds.min}
        max={bounds.max}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setStatus('idle');
        }}
        className="w-32 text-xs rounded-sm border border-border bg-background px-2 py-1 text-foreground"
      />
      <span className="text-[11px] text-muted-foreground block mt-1">
        {hint} {l.range.replace('{min}', String(bounds.min)).replace('{max}', String(bounds.max))}
      </span>
    </label>
  );

  return (
    <div className="space-y-4 max-w-xl">
      <div>
        <h3 className="text-sm font-semibold">{l.title}</h3>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{l.intro}</p>
      </div>
      {saved && (
        <>
          {field(l.perSession, l.perSessionHint, perSession, setPerSession, BOUNDS.perSession, 'agent-task-limit-session')}
          {field(l.perProjectPerDay, l.perProjectPerDayHint, perDay, setPerDay, BOUNDS.perProjectPerDay, 'agent-task-limit-day')}
        </>
      )}
      <div className="flex items-center gap-3">
        <button
          type="button"
          data-testid="agent-task-limits-save"
          disabled={!dirty || status === 'saving'}
          onClick={() => void save()}
          className="px-3 py-1.5 rounded-md text-xs font-semibold bg-primary text-primary-foreground disabled:opacity-40 flex items-center gap-1.5"
        >
          <Save className="w-3.5 h-3.5" />
          {t.common.save}
        </button>
        {status === 'saved' && <span className="text-xs text-emerald-400">{l.saved}</span>}
        {status === 'error' && <span className="text-xs text-red-400">{l.error}</span>}
      </div>
      <p className="text-[11px] text-muted-foreground leading-relaxed">{l.storage}</p>
    </div>
  );
};
