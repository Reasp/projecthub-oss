/**
 * Заголовок и текст предупреждения о лимитах Claude Code на языке интерфейса (TASK-205). main присылает тип, процент
 * и аккаунт; его `title` — английский запасной текст. `message` — текст самого Claude CLI, если он был.
 *
 * Чистый модуль без React — покрыт unit-тестами.
 */
import type { RateLimitWarning } from '../types/electron';

export interface RateLimitLabels {
  bannerTitle: string;
  reached: string;
  near: string;
  account: string;
  usedPercent: string;
}

const fill = (template: string, vars: Record<string, string>) => template.replace(/\{(\w+)\}/g, (all, key: string) => vars[key] ?? all);

export function rateLimitTitle(w: Pick<RateLimitWarning, 'type' | 'utilization' | 'accountName'>, labels: RateLimitLabels): string {
  const base =
    w.type === 'throttled' || (w.utilization ?? 0) >= 100 ? labels.reached : w.type === 'rate_limit' && w.utilization !== undefined ? labels.near : labels.bannerTitle;
  return w.accountName ? `${base} — ${fill(labels.account, { name: w.accountName })}` : base;
}

export function rateLimitMessage(w: Pick<RateLimitWarning, 'message' | 'utilization'>, labels: RateLimitLabels): string {
  return w.message || fill(labels.usedPercent, { percent: String(w.utilization ?? 85) });
}
