/**
 * Подпись «чем обслуживается назначение» для интерфейса (TASK-134.2, decision-75): «opus · Claude Code ·
 * по подписке», «qwen3 · Ollama · локальная» и пояснение, откуда взят выбор.
 *
 * Чистый модуль без React — покрыт unit-тестами.
 */
import type { ModelRouteView } from '../types/electron';
import type { AppErrorLabels } from '../i18n/appErrorText';
import { appFailureText } from './appErrorText';

export interface ModelRouteLabels {
  defaultModel: string;
  subscription: string;
  local: string;
  /** Шаблон «тир {tier} · {source}». */
  tier: string;
  sources: Record<ModelRouteView['source'], string>;
  tierSources: Record<NonNullable<ModelRouteView['tierSource']>, string>;
  problems: Record<NonNullable<ModelRouteView['problem']>['code'], string>;
}

/** Имена движков — собственные, не переводятся. */
const ENGINE_NAMES: Record<Exclude<ModelRouteView['engine'], 'api'>, string> = {
  'claude-cli': 'Claude Code',
  'codex-cli': 'Codex CLI',
  'gemini-cli': 'Gemini CLI'
};

export interface ModelRouteText {
  /** «opus · Claude Code · по подписке». */
  target: string;
  /** Откуда взят выбор: «тир frontier · роль» или «основная модель». */
  origin: string;
  /** Короткая причина, по которой цель непригодна. */
  problem?: string;
  /** Полный текст проблемы и пояснения резолвера — для всплывающей подсказки. */
  details?: string;
}

/** Пояснения и проблема резолвера — по кодам на языке окна, без кода — английский текст main. */
export function describeModelRoute(view: ModelRouteView, labels: ModelRouteLabels, appErrors?: AppErrorLabels): ModelRouteText {
  const where = view.engine === 'api' ? view.provider ?? 'API' : ENGINE_NAMES[view.engine];
  const marks = [view.subscription ? labels.subscription : '', view.local ? labels.local : ''].filter(Boolean);
  const target = [view.model ?? labels.defaultModel, where, ...marks].join(' · ');

  const origin =
    view.tier && view.tierSource
      ? labels.tier.replace('{tier}', view.tier).replace('{source}', labels.tierSources[view.tierSource])
      : labels.sources[view.source];

  const text = (error: string, errorKey: unknown) => (appErrors ? appFailureText({ error, errorKey }, appErrors) : error);
  const problemText = view.problem ? text(view.problem.message, view.problem.messageKey) : undefined;
  const notes = view.notes.map((note, i) => text(note, view.noteKeys?.[i]));
  const details = [problemText, ...notes].filter(Boolean).join('\n');
  return {
    target,
    origin,
    ...(view.problem ? { problem: labels.problems[view.problem.code] } : {}),
    ...(details ? { details } : {})
  };
}

/** Событие, по которому приложение открывает настройки AI на нужном месте. */
export const OPEN_AI_SETTINGS_EVENT = 'projecthub:open-ai-settings';

export interface OpenAiSettingsDetail {
  /** Назначение, строку которого нужно показать. */
  purpose?: string;
}

export function requestOpenAiSettings(detail: OpenAiSettingsDetail = {}): void {
  window.dispatchEvent(new CustomEvent<OpenAiSettingsDetail>(OPEN_AI_SETTINGS_EVENT, { detail }));
}
