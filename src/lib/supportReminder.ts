/**
 * Кнопка поддержки и мягкое напоминание в открытой редакции (TASK-144.6, decision-170). Чистый модуль без React,
 * Electron и localStorage: состояние и время передаёт вызывающий, параметры показа лежат в данных
 * (`supportReminderConfig.json`), ссылка — в общем с сайтом `productLinks.json`.
 */

export interface SupportReminderConfig {
  /** Первое напоминание — не раньше, чем через столько дней после первого запуска. */
  firstDelayDays: number;
  /** Между напоминаниями — не меньше стольких дней («не чаще раза в ~2 недели»). */
  intervalDays: number;
  /** После «Поддержать» — пауза дольше обычной. */
  afterSupportDays: number;
  /** Сколько задач должно перейти в Done с прошлого показа: напоминание видят те, кто работает, а не открыл и закрыл. */
  minDoneTasks: number;
}

export interface SupportReminderState {
  /** Первый запуск с этой функцией, мс эпохи. */
  firstSeenAt: number;
  /** Последний показ (точнее, ответ на него), мс эпохи; `null` — ещё не показывалось. */
  lastShownAt: number | null;
  /** Последнее «Поддержать» в напоминании или клик по кнопке поддержки, мс эпохи. */
  supportedAt: number | null;
  /** Задачи, перешедшие в Done с прошлого показа. */
  doneSinceShown: number;
}

export interface ProductLinks {
  donate?: string | null;
  site?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Куда ведёт кнопка: `links.donate`, а пока его нет — страница поддержки сайта. */
export function supportUrl(links: ProductLinks): string | null {
  if (links.donate) return links.donate;
  if (links.site) return `${links.site.replace(/\/+$/, '')}/donate/`;
  return null;
}

export function initialSupportReminderState(now: number): SupportReminderState {
  return { firstSeenAt: now, lastShownAt: null, supportedAt: null, doneSinceShown: 0 };
}

/** Разбор сохранённого состояния; битое или чужое — начать заново с текущего момента. */
export function parseSupportReminderState(raw: string | null, now: number): SupportReminderState {
  if (!raw) return initialSupportReminderState(now);
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof SupportReminderState, unknown>> | null;
    const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
    const firstSeenAt = num(v?.firstSeenAt);
    if (firstSeenAt === null) return initialSupportReminderState(now);
    // Отметки «из будущего» (часы переводили назад) приводятся к текущему моменту, иначе пауза растянется.
    const notLater = (x: number | null) => (x === null ? null : Math.min(x, now));
    return {
      firstSeenAt: Math.min(firstSeenAt, now),
      lastShownAt: notLater(num(v?.lastShownAt)),
      supportedAt: notLater(num(v?.supportedAt)),
      doneSinceShown: Math.floor(num(v?.doneSinceShown) ?? 0)
    };
  } catch {
    return initialSupportReminderState(now);
  }
}

/** Пора ли показать напоминание. */
export function shouldShowSupportReminder(state: SupportReminderState, now: number, config: SupportReminderConfig): boolean {
  if (state.doneSinceShown < config.minDoneTasks) return false;
  if (state.supportedAt !== null && now - state.supportedAt < config.afterSupportDays * DAY_MS) return false;
  if (state.lastShownAt === null) return now - state.firstSeenAt >= config.firstDelayDays * DAY_MS;
  return now - state.lastShownAt >= config.intervalDays * DAY_MS;
}

/** Ответ на напоминание: «Поддержать» или «Напомнить позже» (закрытие крестиком — то же «позже»). */
export function answerSupportReminder(state: SupportReminderState, answer: 'support' | 'later', now: number): SupportReminderState {
  return { ...state, lastShownAt: now, doneSinceShown: 0, supportedAt: answer === 'support' ? now : state.supportedAt };
}

/** Клик по постоянной кнопке поддержки — тоже поддержка: напоминание надолго не нужно. */
export function markSupported(state: SupportReminderState, now: number): SupportReminderState {
  return { ...state, supportedAt: now };
}

/**
 * Сколько задач впервые оказалось завершёнными между двумя снимками списка задач одного проекта. Задачи, которые уже
 * были завершены или появились сразу завершёнными (первая загрузка проекта), не считаются.
 */
export function countNewlyDone(
  prev: ReadonlyMap<string, string>,
  next: ReadonlyArray<{ id: string; status: string }>,
  isDone: (status: string) => boolean
): number {
  let count = 0;
  for (const task of next) {
    const before = prev.get(task.id);
    if (before !== undefined && !isDone(before) && isDone(task.status)) count++;
  }
  return count;
}

export function addDone(state: SupportReminderState, count: number): SupportReminderState {
  return count > 0 ? { ...state, doneSinceShown: state.doneSinceShown + count } : state;
}
