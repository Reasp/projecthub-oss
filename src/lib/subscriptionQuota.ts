/**
 * Квота подписки Claude Code перед дорогой работой (TASK-134.5, decision-98): остаток 5-часового и
 * недельного окон, причина «нет данных» и предупреждение о параллельном расходе в планировщике и Swarm.
 *
 * Только информирование: ничего здесь не блокирует запуск. Чистый модуль без React — покрыт unit-тестами.
 */
import type { ClaudeUsageData, ClaudeUsageLimitWindow } from '../types/electron';

/** С какого процента расхода окно считается почти исчерпанным. */
export const QUOTA_HIGH_PERCENT = 80;

/**
 * Почему лимитов нет: причины `claude -p /usage` ([[TASK-126]]), окна ещё не приходили (`no_windows`),
 * запрос лимитов упал (`load_error`) или ещё идёт (`loading`).
 */
export type QuotaNoDataReason = 'auth' | 'timeout' | 'failed' | 'unrecognized' | 'no_windows' | 'load_error' | 'loading';

export type QuotaStaleReason = 'timeout' | 'failed' | 'unrecognized';

export interface QuotaWindowView {
  usedPercent: number;
  leftPercent: number;
  resetsAt?: string;
}

export type QuotaLevel = 'normal' | 'high' | 'exhausted' | 'unknown';

export interface QuotaView {
  accountName?: string;
  session?: QuotaWindowView;
  weekly?: QuotaWindowView;
  /** Ни одного окна нет — почему. Нулевой расход так не показывается. */
  noData?: QuotaNoDataReason;
  /** Окна есть, но CLI их сейчас не обновил: показаны последние известные. */
  stale?: QuotaStaleReason;
  level: QuotaLevel;
}

function windowView(window: ClaudeUsageLimitWindow | undefined): QuotaWindowView | undefined {
  if (!window || typeof window.percent !== 'number' || !Number.isFinite(window.percent)) return undefined;
  const used = Math.max(0, Math.min(100, Math.round(window.percent)));
  return { usedPercent: used, leftPercent: 100 - used, ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}) };
}

function levelOf(windows: QuotaWindowView[]): QuotaLevel {
  if (windows.length === 0) return 'unknown';
  const used = Math.max(...windows.map((w) => w.usedPercent));
  if (used >= 100) return 'exhausted';
  if (used >= QUOTA_HIGH_PERCENT) return 'high';
  return 'normal';
}

/** Вид лимитов одного аккаунта; `usage === undefined` — ответа ещё нет (или запрос упал при `loadFailed`). */
export function quotaView(usage: ClaudeUsageData | null | undefined, loadFailed = false): QuotaView {
  if (!usage) return { noData: loadFailed ? 'load_error' : 'loading', level: 'unknown' };
  const kind = usage.cliError?.kind;
  const accountName = usage.accountName ? { accountName: usage.accountName } : {};
  // Профиль без входа: старые окна чужой сессии не показываем (TASK-152.5).
  if (kind === 'auth') return { ...accountName, noData: 'auth', level: 'unknown' };
  const session = windowView(usage.sessionLimit);
  const weekly = windowView(usage.weeklyLimit);
  const windows = [session, weekly].filter((w): w is QuotaWindowView => Boolean(w));
  if (windows.length === 0) return { ...accountName, noData: kind ?? 'no_windows', level: 'unknown' };
  return {
    ...accountName,
    ...(session ? { session } : {}),
    ...(weekly ? { weekly } : {}),
    ...(kind ? { stale: kind } : {}),
    level: levelOf(windows)
  };
}

/**
 * Время сброса окна. Из rate-limit событий приходит ISO-строка — она форматируется; CLI пишет своё
 * («3pm (Europe/Moscow)») — оно показывается как есть, без попытки разбора.
 */
export function formatQuotaReset(resetsAt: string | undefined, locale: string, now: Date = new Date()): string | undefined {
  if (!resetsAt?.trim()) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(resetsAt)) return resetsAt.trim();
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return resetsAt.trim();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * Сколько узлов плана реально пойдут одновременно: не больше лимита плана и не больше самого широкого
 * уровня графа (узлы следующего уровня ждут слияния предыдущего, decision-49).
 */
export function planParallelism(maxParallel: number | undefined, levelWidths: number[]): number {
  const limit = Math.max(1, Math.floor(Number.isFinite(maxParallel) ? (maxParallel as number) : 1));
  const widest = levelWidths.length > 0 ? Math.max(...levelWidths) : 1;
  return Math.max(1, Math.min(limit, widest));
}

export type SwarmQuotaMode = 'fan_out' | 'handoff' | 'done_loop';

export interface SwarmQuotaSlot {
  engine: string;
  claudeAccountId?: string;
  roleSlug?: string;
}

export interface SwarmQuotaGroup {
  /** Профиль аккаунта Claude Code; `undefined` — аккаунт проекта. */
  accountId?: string;
  slots: number;
  /** Сколько слотов этого аккаунта работают одновременно. */
  parallel: number;
}

export interface SwarmQuotaPlan {
  /** Слоты по подписке (`claude-cli`); остальные квоту подписки не тратят. */
  subscriptionSlots: number;
  allSubscription: boolean;
  groups: SwarmQuotaGroup[];
  /** Наибольшая параллельность на одном аккаунте: окно одно на аккаунт. */
  parallel: number;
}

/**
 * Аккаунт Claude Code запуска — как в main (decision-87): слот → роль → проект. Ссылка на удалённый
 * профиль пропускается; `undefined` — аккаунт проекта.
 */
export function quotaAccountId(
  slot: Pick<SwarmQuotaSlot, 'claudeAccountId' | 'roleSlug'>,
  roleAccounts: Record<string, string> = {},
  knownAccountIds?: string[]
): string | undefined {
  const valid = (id: string | undefined): string | undefined =>
    id && (!knownAccountIds || knownAccountIds.includes(id)) ? id : undefined;
  return valid(slot.claudeAccountId) ?? valid(slot.roleSlug ? roleAccounts[slot.roleSlug] : undefined);
}

/**
 * Слоты Swarm по аккаунтам подписки (`quotaAccountId`). Параллельно идут только участники арены;
 * этапы конвейера и цикл «до готовности» работают по очереди.
 */
export function swarmQuotaPlan(
  mode: SwarmQuotaMode,
  slots: SwarmQuotaSlot[],
  roleAccounts: Record<string, string> = {},
  knownAccountIds?: string[]
): SwarmQuotaPlan {
  const subscription = slots.filter((slot) => slot.engine === 'claude-cli');
  const byAccount = new Map<string, SwarmQuotaGroup>();
  for (const slot of subscription) {
    const accountId = quotaAccountId(slot, roleAccounts, knownAccountIds);
    const key = accountId ?? '';
    const group = byAccount.get(key) ?? { ...(accountId ? { accountId } : {}), slots: 0, parallel: 0 };
    group.slots += 1;
    group.parallel = mode === 'fan_out' ? group.slots : 1;
    byAccount.set(key, group);
  }
  const groups = [...byAccount.values()];
  return {
    subscriptionSlots: subscription.length,
    allSubscription: slots.length > 0 && subscription.length === slots.length,
    groups,
    parallel: groups.reduce((max, g) => Math.max(max, g.parallel), 0)
  };
}
