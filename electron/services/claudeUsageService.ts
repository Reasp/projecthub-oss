import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { claudeAccountService, runClaudeCliWithAccount } from './claudeAccountService.js';
import { DEFAULT_CLAUDE_ACCOUNT_ID, type ClaudeAccountProfile } from './claudeAccounts.js';
import {
  interpretUsageCliResult,
  isLoggedOutAuthStatus,
  type ClaudeUsageCliError,
  type ClaudeUsageCliResult
} from './claudeUsageCliResult.js';

export interface ClaudeUsageLimitWindow {
  percent: number;
  resetsAt?: string;
}

export interface ClaudeUsageBreakdownItem {
  name: string;
  percent: number;
}

export interface ClaudeUsageBreakdown {
  requests?: number;
  sessions?: number;
  contextAbove150kPercent?: number;
  subagentHeavyPercent?: number;
  sessionsOver8hPercent?: number;
  topSkills?: ClaudeUsageBreakdownItem[];
  topSubagents?: ClaudeUsageBreakdownItem[];
  topMcpServers?: ClaudeUsageBreakdownItem[];
}

export interface ClaudeModelTokenStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD?: number;
}

export interface ClaudeUsageData {
  planType: string;
  sessionLimit?: ClaudeUsageLimitWindow;
  weeklyLimit?: ClaudeUsageLimitWindow;
  fableLimit?: ClaudeUsageLimitWindow;
  last24h?: ClaudeUsageBreakdown;
  last7d?: ClaudeUsageBreakdown;
  totalSessions?: number;
  totalMessages?: number;
  modelUsage?: Record<string, ClaudeModelTokenStats>;
  dailyActivity?: {
    date: string;
    messageCount: number;
    sessionCount: number;
    toolCallCount: number;
  }[];
  rawText?: string;
  updatedAt: number;
  isFallback?: boolean;
  /** Профиль аккаунта Claude Code, чьи это лимиты (TASK-152.5, decision-87 п. 13). */
  accountId?: string;
  accountName?: string;
  /** Почему `claude -p /usage` не дал лимитов (TASK-126); при успешном ответе поля нет. */
  cliError?: ClaudeUsageCliError;
}

/**
 * Сырое событие `rate_limit_event` из stream-json Claude CLI (поля по факту наблюдений,
 * все опциональны). `utilization` — доля 0..1, `resetsAt` — unix-секунды или ISO-строка.
 */
export interface ClaudeRateLimitEventInfo {
  status?: string;
  rateLimitType?: string;
  rate_limit_type?: string;
  windowType?: string;
  utilization?: number;
  resetsAt?: number | string;
  reset_at?: number | string;
  unifiedWindows?: ClaudeRateLimitEventInfo[];
}

/** Окна лимитов, накопленные из rate-limit событий CLI (без запросов к API). */
export interface ClaudeRateLimitSnapshot {
  sessionLimit?: ClaudeUsageLimitWindow;
  weeklyLimit?: ClaudeUsageLimitWindow;
  fableLimit?: ClaudeUsageLimitWindow;
  updatedAt: number;
}

function formatResetsAt(value: number | string | undefined): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const date = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value : undefined;
  return date.toISOString();
}

/** Лимиты и кэш одного аккаунта: `/usage` тратит время и квоту, поэтому кэш — на профиль. */
interface AccountUsageState {
  cachedUsage: ClaudeUsageData | null;
  lastFetchTime: number;
  rateLimits: ClaudeRateLimitSnapshot | null;
  inflight: Promise<ClaudeUsageData> | null;
}

class ClaudeUsageService {
  private readonly CACHE_TTL_MS = 45 * 1000; // 45 seconds
  // Замер 2026-10-05 (CLI 2.1.289): ответ за 6.3 с, прежние 8 с срабатывали на загруженной машине.
  private readonly CLI_TIMEOUT_MS = 20 * 1000;
  private readonly AUTH_STATUS_TIMEOUT_MS = 5 * 1000;
  private accounts = new Map<string, AccountUsageState>();

  private state(accountId: string): AccountUsageState {
    let state = this.accounts.get(accountId);
    if (!state) {
      state = { cachedUsage: null, lastFetchTime: 0, rateLimits: null, inflight: null };
      this.accounts.set(accountId, state);
    }
    return state;
  }

  /**
   * Получение лимитов и статистики Claude Code одного аккаунта (по умолчанию — профиля по умолчанию).
   * Схема гибридная:
   * 1. Безопасный CLI-вызов `claude -p /usage` с каталогом аккаунта (с закрытым stdin, не тратит токены
   *    модели, возвращает актуальные лимиты сессии, недели, Fable и активность за 24ч/7д).
   * 2. Оперативные rate-limit события `rate_limit_event` из идущих сессий Claude CLI этого аккаунта (`noteRateLimitEvent`).
   * 3. Локальный кэш `stats-cache.json` каталога аккаунта для исторических показателей сессий и сообщений.
   *
   * В обычный `~/.claude` сервис не ходит (decision-87 п. 13): профиль без входа показывает «нет входа».
   */
  public async getUsage(forceRefresh = false, accountId: string = DEFAULT_CLAUDE_ACCOUNT_ID): Promise<ClaudeUsageData> {
    const account = await claudeAccountService.getAccount(accountId);
    if (!account) throw new Error('Профиль аккаунта Claude Code не найден.');
    const state = this.state(account.id);
    const now = Date.now();
    if (!forceRefresh && state.cachedUsage && now - state.lastFetchTime < this.CACHE_TTL_MS) {
      return state.cachedUsage;
    }
    if (state.inflight) return state.inflight;
    state.inflight = this.fetchUsage(account, state).finally(() => {
      state.inflight = null;
    });
    return state.inflight;
  }

  /** Лимиты аккаунта проекта (привязка в реестре машины, иначе профиль по умолчанию). */
  public async getUsageForProject(projectPath: string | undefined, forceRefresh = false): Promise<ClaudeUsageData> {
    const { account } = await claudeAccountService.resolve({ projectPath });
    return this.getUsage(forceRefresh, account.id);
  }

  private async fetchUsage(account: ClaudeAccountProfile, state: AccountUsageState): Promise<ClaudeUsageData> {
    const now = Date.now();
    let cliUsageText: string | null = null;
    let cliError: ClaudeUsageCliError | undefined;
    let parsedFromCli: ReturnType<typeof this.parseUsageText> | null = null;

    try {
      const cliResult = await this.fetchUsageFromCli(account.configDir);
      if (cliResult) {
        cliUsageText = cliResult.text || null;
        cliError = cliResult.error;
        // Текст отказа не парсим: лимитов в нём нет, а тип подписки из него не следует.
        if (cliUsageText && (!cliError || cliError.kind === 'unrecognized')) {
          parsedFromCli = this.parseUsageText(cliUsageText);
          if (parsedFromCli.sessionLimit || parsedFromCli.weeklyLimit || parsedFromCli.fableLimit) {
            const nextSnapshot: ClaudeRateLimitSnapshot = {
              ...(state.rateLimits ?? { updatedAt: 0 }),
              updatedAt: now
            };
            if (parsedFromCli.sessionLimit) nextSnapshot.sessionLimit = parsedFromCli.sessionLimit;
            if (parsedFromCli.weeklyLimit) nextSnapshot.weeklyLimit = parsedFromCli.weeklyLimit;
            if (parsedFromCli.fableLimit) nextSnapshot.fableLimit = parsedFromCli.fableLimit;
            state.rateLimits = nextSnapshot;
          }
        }
      }
    } catch (err: any) {
      cliError = { kind: 'failed', detail: err?.message || String(err) };
    }

    if (cliError) {
      // Если CLI недоступен или не авторизован, откатываемся на кэш и снимки этого аккаунта, а причину отдаём в UI
      console.warn(
        `[ClaudeUsage] CLI fetch failed for account "${account.id}" (${cliError.kind}), falling back to local cache & rate limit snapshot:`,
        cliError.detail ?? ''
      );
    }

    // Профиль без входа не показывает старых лимитов (TASK-152.5 AC #3).
    const rateLimits = cliError?.kind === 'auth' ? null : state.rateLimits;
    const statsCacheData = await this.readStatsCacheFile(account.configDir);

    if (!parsedFromCli && !statsCacheData && !rateLimits && !cliError) {
      throw new Error(
        'Не удалось получить usage данные Claude Code: нет ответа от CLI, отсутствует stats-cache.json и ещё не было rate-limit событий'
      );
    }

    const sessionLimit = rateLimits?.sessionLimit ?? parsedFromCli?.sessionLimit;
    const weeklyLimit = rateLimits?.weeklyLimit ?? parsedFromCli?.weeklyLimit;
    const fableLimit = rateLimits?.fableLimit ?? parsedFromCli?.fableLimit;

    const usage: ClaudeUsageData = {
      planType: parsedFromCli?.planType || 'Claude Code Subscription',
      sessionLimit,
      weeklyLimit,
      fableLimit,
      last24h: parsedFromCli?.last24h,
      last7d: parsedFromCli?.last7d,
      totalSessions: statsCacheData?.totalSessions,
      totalMessages: statsCacheData?.totalMessages,
      modelUsage: statsCacheData?.modelUsage,
      dailyActivity: statsCacheData?.dailyActivity,
      rawText: cliUsageText || this.describeSources(statsCacheData !== null, account, rateLimits),
      updatedAt: now,
      isFallback: !rateLimits && !parsedFromCli?.sessionLimit && !parsedFromCli?.weeklyLimit,
      cliError,
      accountId: account.id,
      accountName: account.name
    };

    state.cachedUsage = usage;
    state.lastFetchTime = now;
    return usage;
  }

  /**
   * Запуск `claude -p /usage` с каталогом аккаунта. Не отклоняется: отказ авторизации, таймаут и сбой
   * запуска приходят в поле `error`. `null` — CLI не опрашивался.
   */
  public async fetchUsageFromCli(configDir: string): Promise<ClaudeUsageCliResult | null> {
    // В тестах Vitest не спауним внешний CLI, чтобы тесты выполнялись изолированно и детерминированно
    if (process.env.VITEST) return null;

    // Без --no-session-persistence каждый опрос оставлял файл сессии в <каталог аккаунта>/projects/<cwd>.
    const run = await runClaudeCliWithAccount(['-p', '/usage', '--no-session-persistence'], configDir, this.CLI_TIMEOUT_MS);
    if (run.timedOut) return { text: '', error: { kind: 'timeout' } };
    if (run.spawnError) return { text: '', error: { kind: 'failed', detail: run.spawnError } };

    const result = interpretUsageCliResult(run.code, run.stdout, run.stderr);
    // Профиль без входа отвечает на /usage сводкой стоимости сессии с кодом 0 — причину уточняет auth status.
    if (result.error && result.error.kind !== 'auth') {
      const status = await runClaudeCliWithAccount(['auth', 'status'], configDir, this.AUTH_STATUS_TIMEOUT_MS);
      if (isLoggedOutAuthStatus(status.stdout)) return { text: result.text, error: { kind: 'auth' } };
    }
    return result;
  }

  private describeSources(hasStatsCache: boolean, account: ClaudeAccountProfile, rateLimits: ClaudeRateLimitSnapshot | null): string {
    const statsFile = path.join(account.configDir, 'stats-cache.json');
    const lines = [
      `Аккаунт: «${account.name}» (${account.configDir}).`,
      hasStatsCache
        ? `Сессии, сообщения и токены: локальный кэш Claude Code (${statsFile}).`
        : `Локальный кэш Claude Code (${statsFile}) не найден.`,
      rateLimits
        ? `Лимиты: rate-limit события Claude CLI, последнее ${new Date(rateLimits.updatedAt).toLocaleString()}.`
        : 'Окна лимитов получены из снимка rate-limit событий Claude CLI.',
      'Для прямого опроса лимитов и квот подписки используется вызов `claude -p /usage`.'
    ];
    return lines.join('\n');
  }

  /** Текущие окна лимитов, накопленные из событий CLI (для тестов и диагностики). */
  public getRateLimitSnapshot(accountId: string = DEFAULT_CLAUDE_ACCOUNT_ID): ClaudeRateLimitSnapshot | null {
    return this.accounts.get(accountId)?.rateLimits ?? null;
  }

  /**
   * Учесть `rate_limit_event` из stream-json Claude CLI. Окно определяется по типу лимита:
   * `five_hour` → сессия, `seven_day` → неделя, `seven_day_<model>` → отдельная модельная
   * квота (в UI — «Fable»). Событие без числовой `utilization` игнорируется.
   */
  public noteRateLimitEvent(info: ClaudeRateLimitEventInfo | null | undefined, accountId: string = DEFAULT_CLAUDE_ACCOUNT_ID): void {
    if (!info || typeof info !== 'object') return;
    const state = this.state(accountId);
    const windows = Array.isArray(info.unifiedWindows) && info.unifiedWindows.length > 0 ? info.unifiedWindows : [info];

    let changed = false;
    const next: ClaudeRateLimitSnapshot = { ...(state.rateLimits ?? { updatedAt: 0 }) };

    for (const win of windows) {
      if (!win || typeof win.utilization !== 'number' || !Number.isFinite(win.utilization)) continue;
      const type = String(win.rateLimitType ?? win.rate_limit_type ?? win.windowType ?? info.rateLimitType ?? '').toLowerCase();
      const window: ClaudeUsageLimitWindow = {
        percent: Math.max(0, Math.min(100, Math.round(win.utilization * 100))),
        resetsAt: formatResetsAt(win.resetsAt ?? win.reset_at)
      };

      if (type.includes('five_hour') || type.includes('session')) {
        next.sessionLimit = window;
      } else if (type.includes('seven_day') && /seven_day_[a-z]/.test(type)) {
        next.fableLimit = window;
      } else if (type.includes('seven_day') || type.includes('week')) {
        next.weeklyLimit = window;
      } else if (!next.sessionLimit) {
        // Тип неизвестен: считаем окном сессии, но только если оно ещё не заполнено.
        next.sessionLimit = window;
      } else {
        continue;
      }
      changed = true;
    }

    if (!changed) return;
    next.updatedAt = Date.now();
    state.rateLimits = next;
    // Сбросить кэш, чтобы следующий getUsage отдал свежие лимиты.
    state.lastFetchTime = 0;
  }

  /** `stats-cache.json` каталога аккаунта; в обычный `~/.claude` не заглядываем — это другой аккаунт. */
  private async readStatsCacheFile(configDir: string): Promise<any | null> {
    const filePath = path.join(configDir, 'stats-cache.json');
    if (!existsSync(filePath)) return null;
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf-8'));
    } catch (e) {
      console.warn(`Error reading ${filePath}:`, e);
      return null;
    }
  }

  public parseUsageText(text: string): {
    planType: string;
    sessionLimit?: ClaudeUsageLimitWindow;
    weeklyLimit?: ClaudeUsageLimitWindow;
    fableLimit?: ClaudeUsageLimitWindow;
    last24h?: ClaudeUsageBreakdown;
    last7d?: ClaudeUsageBreakdown;
  } {
    let planType = 'Claude Code Subscription';
    if (text.includes('subscription')) {
      planType = 'Claude Subscription (Max Speed)';
    } else if (text.includes('usage credits') || text.includes('credits')) {
      planType = 'Usage Credits (Pay-as-you-go)';
    }

    let sessionLimit: ClaudeUsageLimitWindow | undefined;
    const sessionMatch = text.match(/Current session:\s*(\d+)%\s*used(?:\s*·\s*resets\s*([^\r\n]+))?/i);
    if (sessionMatch) {
      sessionLimit = {
        percent: parseInt(sessionMatch[1], 10),
        resetsAt: sessionMatch[2]?.trim()
      };
    }

    let weeklyLimit: ClaudeUsageLimitWindow | undefined;
    // Сначала ищем общее "Current week (all models):" или явное "Current week:"
    const allModelsMatch = text.match(/Current week\s*\((?:all models|all)\):\s*(\d+)%\s*used(?:\s*·\s*resets\s*([^\r\n]+))?/i);
    const plainWeeklyMatch = text.match(/Current week:\s*(\d+)%\s*used(?:\s*·\s*resets\s*([^\r\n]+))?/i);
    const matchedWeekly = allModelsMatch || plainWeeklyMatch;
    if (matchedWeekly) {
      weeklyLimit = {
        percent: parseInt(matchedWeekly[1], 10),
        resetsAt: matchedWeekly[2]?.trim()
      };
    } else {
      // Запасной вариант: если есть "Current week (...)" и это не Fable
      const genericWeeklyMatch = text.match(/Current week(?:\s*\((?!fable)[^)]+\))?:\s*(\d+)%\s*used(?:\s*·\s*resets\s*([^\r\n]+))?/i);
      if (genericWeeklyMatch) {
        weeklyLimit = {
          percent: parseInt(genericWeeklyMatch[1], 10),
          resetsAt: genericWeeklyMatch[2]?.trim()
        };
      }
    }

    let fableLimit: ClaudeUsageLimitWindow | undefined;
    // Отдельный лимит для модели Fable (Claude 3.7 Sonnet / hybrid reasoning): "Current week (Fable): XX% used"
    const fableMatch = text.match(/Current week\s*\((?:fable)\):\s*(\d+)%\s*used(?:\s*·\s*resets\s*([^\r\n]+))?/i);
    if (fableMatch) {
      fableLimit = {
        percent: parseInt(fableMatch[1], 10),
        resetsAt: fableMatch[2]?.trim()
      };
    }

    const parseSection = (sectionText: string): ClaudeUsageBreakdown => {
      const breakdown: ClaudeUsageBreakdown = {};

      const reqMatch = sectionText.match(/(\d+)\s+requests/i);
      if (reqMatch) breakdown.requests = parseInt(reqMatch[1], 10);

      const sessMatch = sectionText.match(/(\d+)\s+sessions/i);
      if (sessMatch) breakdown.sessions = parseInt(sessMatch[1], 10);

      const ctxMatch = sectionText.match(/(\d+)%\s+of your usage was at >150k context/i);
      if (ctxMatch) breakdown.contextAbove150kPercent = parseInt(ctxMatch[1], 10);

      const subagentMatch = sectionText.match(/(\d+)%\s+of your usage came from subagent-heavy/i);
      if (subagentMatch) breakdown.subagentHeavyPercent = parseInt(subagentMatch[1], 10);

      const durMatch = sectionText.match(/(\d+)%\s+of your usage came from sessions active for 8\+\s*hours/i);
      if (durMatch) breakdown.sessionsOver8hPercent = parseInt(durMatch[1], 10);

      const parseItems = (regex: RegExp): ClaudeUsageBreakdownItem[] => {
        const match = sectionText.match(regex);
        if (!match) return [];
        const rawItems = match[1].split(',');
        return rawItems
          .map((item) => {
            const m = item.trim().match(/^(.+?)\s+(\d+)%$/);
            if (m) {
              return { name: m[1].trim(), percent: parseInt(m[2], 10) };
            }
            return null;
          })
          .filter(Boolean) as ClaudeUsageBreakdownItem[];
      };

      breakdown.topSkills = parseItems(/Top skills:\s*([^\n\r]+)/i);
      breakdown.topSubagents = parseItems(/Top subagents:\s*([^\n\r]+)/i);
      breakdown.topMcpServers = parseItems(/Top MCP servers:\s*([^\n\r]+)/i);

      return breakdown;
    };

    let last24h: ClaudeUsageBreakdown | undefined;
    let last7d: ClaudeUsageBreakdown | undefined;

    const idx24h = text.indexOf('Last 24h');
    const idx7d = text.indexOf('Last 7d');

    if (idx24h !== -1) {
      const sub24h = idx7d !== -1 ? text.slice(idx24h, idx7d) : text.slice(idx24h);
      last24h = parseSection(sub24h);
    }

    if (idx7d !== -1) {
      const sub7d = text.slice(idx7d);
      last7d = parseSection(sub7d);
    }

    return {
      planType,
      sessionLimit,
      weeklyLimit,
      fableLimit,
      last24h,
      last7d
    };
  }
}

export const claudeUsageService = new ClaudeUsageService();
