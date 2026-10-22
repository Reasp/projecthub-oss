/**
 * Тексты отказов git-операций для человека (TASK-201, правило 25): main-процесс отдаёт код причины, текст берётся
 * из словарей i18n. Русские `text`/`error` результатов предназначены модели и логу, в интерфейс не попадают.
 *
 * Чистый модуль без React — покрыт unit-тестами.
 */
import type { MergeFailure, PullBaseResult } from '../types/electron';

export type BaseSyncRefusalCode = NonNullable<PullBaseResult['reason']>['code'];

export interface BaseSyncLabels {
  /** Шаблоны с подстановками {branch}, {base}, {count}, {detail}. */
  refusals: Record<BaseSyncRefusalCode, string>;
  /** Отказ без кода (старый main-процесс, сбой IPC): «Не удалось подтянуть {base}». */
  unknown: string;
}

/** Шаблоны с подстановкой {detail}; `unknown` — отказ без кода. */
export type MergeFailureLabels = Record<MergeFailure['code'] | 'unknown', string>;

const fill = (template: string, vars: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (all, key: string) => vars[key] ?? all);

/** Отказ «подтянуть целевую ветку в worktree» (`runBaseSync`); `base` — ветка, выбранная в окне. */
export function describeBaseSyncRefusal(res: Pick<PullBaseResult, 'reason' | 'target'>, labels: BaseSyncLabels, base: string): string {
  return fill(res.reason ? labels.refusals[res.reason.code] : labels.unknown, {
    branch: res.reason?.branch ?? '',
    base: res.target?.base ?? base,
    count: String(res.reason?.count ?? 0),
    detail: res.reason?.detail ?? ''
  });
}

/** Отказ окна конфликтов: разрешить файл, завершить или отменить слияние. */
export function describeMergeFailure(failure: MergeFailure | undefined, labels: MergeFailureLabels): string {
  return fill(failure ? labels[failure.code] : labels.unknown, { detail: failure?.detail ?? '' });
}
