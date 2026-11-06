import React, { useState } from 'react';
import { AlertTriangle, GitFork, Loader2, Square } from '../common/icons';
import type { ProviderErrorInfo } from '../../types/electron';
import { useTranslation } from '../../i18n/useTranslation';
import { asAppErrorKey, formatAppError } from '../../lib/appError';
import { AdviceText } from './ProviderErrorCard';

interface CliBackgroundSessionCardProps {
  info: ProviderErrorInfo;
  /** Английский запасной текст ошибки из main. */
  error: string;
  /** Остановить фоновую сессию (`stop`) или продолжить копией (`fork`); строка — ошибка остановки на языке окна. */
  onAction: (action: 'stop' | 'fork') => Promise<string | null>;
  disabled?: boolean;
}

/**
 * Разговор вкладки Claude Code открыт в фоновой сессии CLI (`claude --bg`, TASK-301, decision-219): пока она жива, CLI
 * не даёт вкладке продолжить разговор. Карточка объясняет это на языке окна и предлагает остановить фоновую сессию или
 * продолжить в копии разговора.
 */
export const CliBackgroundSessionCard: React.FC<CliBackgroundSessionCardProps> = ({ info, error, onAction, disabled }) => {
  const { t } = useTranslation();
  const text = t.aiStudio.backgroundSession;
  const [busy, setBusy] = useState<'stop' | 'fork' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const key = asAppErrorKey(info.messageKey);
  const body = (key && formatAppError(key, t.appErrors)) || error;

  const run = async (action: 'stop' | 'fork') => {
    setBusy(action);
    setFailure(null);
    try {
      setFailure(await onAction(action));
    } finally {
      setBusy(null);
    }
  };

  const locked = disabled || busy !== null;
  return (
    <div className="mt-2 w-full rounded-xl border border-amber-500/30 bg-amber-950/30 text-amber-100 text-xs overflow-hidden" role="alert" data-testid="studio-cli-background-card">
      <div className="px-3.5 py-2.5 flex items-start gap-2.5">
        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="font-semibold text-amber-200">{text.title}</div>
          <p className="text-amber-100/90 leading-relaxed whitespace-pre-wrap break-words">
            <AdviceText text={body} />
          </p>
          {busy === 'stop' && (
            <p className="flex items-center gap-1.5 text-[11px] text-amber-300/80">
              <Loader2 className="w-3 h-3 animate-spin" />
              {text.working}
            </p>
          )}
          {failure && <p className="text-[11px] text-rose-300 whitespace-pre-wrap break-words">{failure}</p>}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void run('stop')}
              disabled={locked}
              title={text.stopAndContinueHint}
              data-testid="studio-cli-background-stop"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-600/80 hover:bg-amber-500 text-white text-[11px] font-semibold disabled:opacity-40"
            >
              <Square className="w-3 h-3" />
              {text.stopAndContinue}
            </button>
            <button
              type="button"
              onClick={() => void run('fork')}
              disabled={locked}
              title={text.continueCopyHint}
              data-testid="studio-cli-background-fork"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-700/80 hover:bg-slate-600 text-white text-[11px] font-semibold disabled:opacity-40"
            >
              <GitFork className="w-3 h-3" />
              {text.continueCopy}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
