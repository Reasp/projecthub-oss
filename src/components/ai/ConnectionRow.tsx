import React from 'react';
import type { ConnectionIcon } from '../../lib/connections';
import { ProviderIcon } from './ProviderIcon';

interface ConnectionRowProps {
  icon: ConnectionIcon;
  /** Подпись значка для экранного диктора и подсказки: «Claude Code», «OpenRouter»… */
  providerLabel: string;
  name: string;
  badges?: React.ReactNode;
  /** Вторая строка: почта и тариф, адрес сервера. */
  details?: React.ReactNode;
  /** Полная справка в подсказке строки (каталог, адрес). */
  title?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  testId?: string;
}

/** Строка списка подключений (TASK-172): значок провайдера, имя, детали и действия справа. */
export const ConnectionRow: React.FC<ConnectionRowProps> = ({ icon, providerLabel, name, badges, details, title, actions, children, testId }) => (
  <li className="px-3 py-2.5 rounded-lg bg-ph-base border border-ph-line" data-testid={testId}>
    <div className="flex items-center gap-3 min-w-0" title={title}>
      <span className="w-7 h-7 rounded-md bg-ph-raised flex items-center justify-center shrink-0" title={providerLabel} aria-label={providerLabel}>
        <ProviderIcon icon={icon} className="w-4 h-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-medium text-slate-100 truncate">{name}</span>
          <span className="text-[11px] text-slate-500 shrink-0">· {providerLabel}</span>
          {badges}
        </div>
        {details && <div className="text-[11px] text-slate-400 truncate mt-0.5">{details}</div>}
      </div>
      {actions && <div className="flex items-center gap-1 shrink-0">{actions}</div>}
    </div>
    {children}
  </li>
);

export const connectionBadge = 'text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 shrink-0';
