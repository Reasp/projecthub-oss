/**
 * Cron-выражения для Automations (TASK-74, decision-52 п. 4).
 *
 * Чистый модуль без зависимостей: стандартные 5 полей (минута, час, день месяца, месяц, день
 * недели), `*`, списки, диапазоны, шаги, имена месяцев и дней, макросы `@hourly` … `@monthly`.
 * Время — локальное время машины. Секунд, `L`, `W`, `#` и `@reboot` нет намеренно.
 *
 * Ошибка разбора — код `automations.cron*` (decision-165): редактор правил показывает её на языке окна.
 */
import { AppError, type AppErrorKey, type AppErrorParam } from '../../src/lib/appError.js';
import type { AppErrorCode } from '../../src/i18n/appErrorText.js';

export class CronParseError extends AppError {
  constructor(code: AppErrorCode, params?: Record<string, AppErrorParam>) {
    super(code, params);
    this.name = 'CronParseError';
  }
}

export interface ParsedCron {
  /** Исходное выражение (после раскрытия макроса). */
  source: string;
  minute: boolean[];
  hour: boolean[];
  /** Индексы 1..31. */
  dayOfMonth: boolean[];
  /** Индексы 1..12. */
  month: boolean[];
  /** Индексы 0..6, 0 — воскресенье. */
  dayOfWeek: boolean[];
  /** Поле дня месяца задано как `*` (с шагом или без) — влияет на правило OR/AND дней. */
  dayOfMonthStar: boolean;
  dayOfWeekStar: boolean;
}

const MACROS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *'
};

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface FieldSpec {
  /** Имя поля в ошибке — кодом словаря. */
  name: AppErrorKey;
  min: number;
  max: number;
  names?: string[];
  /** Смещение индекса имени: для месяцев `jan` — 1. */
  nameOffset?: number;
}

const FIELDS: FieldSpec[] = [
  { name: { code: 'automations.cronFieldMinute' }, min: 0, max: 59 },
  { name: { code: 'automations.cronFieldHour' }, min: 0, max: 23 },
  { name: { code: 'automations.cronFieldDayOfMonth' }, min: 1, max: 31 },
  { name: { code: 'automations.cronFieldMonth' }, min: 1, max: 12, names: MONTH_NAMES, nameOffset: 1 },
  // 7 допускается как воскресенье и сворачивается в 0 после разбора.
  { name: { code: 'automations.cronFieldDayOfWeek' }, min: 0, max: 7, names: DAY_NAMES, nameOffset: 0 }
];

function parseValue(raw: string, spec: FieldSpec): number {
  const lower = raw.toLowerCase();
  if (spec.names) {
    const idx = spec.names.indexOf(lower);
    if (idx >= 0) return idx + (spec.nameOffset ?? 0);
  }
  if (!/^\d+$/.test(raw)) throw new CronParseError('automations.cronBadValue', { field: spec.name, value: raw });
  const value = Number(raw);
  if (value < spec.min || value > spec.max) {
    throw new CronParseError('automations.cronOutOfRange', { field: spec.name, value, min: spec.min, max: spec.max });
  }
  return value;
}

function parseField(raw: string, spec: FieldSpec): { values: boolean[]; star: boolean } {
  const values = new Array<boolean>(spec.max + 1).fill(false);
  let star = false;
  for (const part of raw.split(',')) {
    if (!part) throw new CronParseError('automations.cronEmptyItem', { field: spec.name });
    const [rangePart, stepPart, extra] = part.split('/');
    if (extra !== undefined) throw new CronParseError('automations.cronExtraSlash', { field: spec.name, part });
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) {
        throw new CronParseError('automations.cronBadStep', { field: spec.name, step: stepPart });
      }
      step = Number(stepPart);
    }
    let from: number;
    let to: number;
    if (rangePart === '*') {
      star = true;
      from = spec.min;
      to = spec.max === 7 ? 6 : spec.max;
    } else if (rangePart.includes('-')) {
      const [a, b, more] = rangePart.split('-');
      if (more !== undefined || !a || !b) throw new CronParseError('automations.cronBadRange', { field: spec.name, range: rangePart });
      from = parseValue(a, spec);
      to = parseValue(b, spec);
      // `sat-sun`: воскресенье в конце диапазона дней недели — это 7, а не 0.
      if (spec.max === 7 && to === 0 && from > 0) to = 7;
      if (from > to) throw new CronParseError('automations.cronReversedRange', { field: spec.name, range: rangePart });
    } else {
      from = parseValue(rangePart, spec);
      // `5/15` — от 5 до конца диапазона с шагом, как в Vixie cron.
      to = stepPart !== undefined ? (spec.max === 7 ? 6 : spec.max) : from;
    }
    for (let v = from; v <= to; v += step) values[v] = true;
  }
  return { values, star };
}

/** Разбирает выражение; бросает `CronParseError` с понятной причиной. */
export function parseCron(expression: string): ParsedCron {
  const trimmed = String(expression ?? '').trim();
  if (!trimmed) throw new CronParseError('automations.cronEmpty');
  const source = MACROS[trimmed.toLowerCase()] ?? trimmed;
  if (source.startsWith('@')) throw new CronParseError('automations.cronUnknownMacro', { macro: trimmed });
  const parts = source.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronParseError('automations.cronFieldCount', { count: parts.length });
  }
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  const dayOfWeek = dow.values.slice(0, 7);
  if (dow.values[7]) dayOfWeek[0] = true;
  return {
    source,
    minute: minute.values,
    hour: hour.values,
    dayOfMonth: dom.values,
    month: month.values,
    dayOfWeek,
    dayOfMonthStar: dom.star,
    dayOfWeekStar: dow.star
  };
}

/** Проверка без исключения — для zod-схемы и формы редактора: ошибка с кодом или `null`. */
export function validateCron(expression: string): AppError | null {
  try {
    parseCron(expression);
    return null;
  } catch (err) {
    return err instanceof AppError ? err : new CronParseError('automations.cronEmpty');
  }
}

function dayMatches(cron: ParsedCron, d: Date): boolean {
  const dom = cron.dayOfMonth[d.getDate()];
  const dow = cron.dayOfWeek[d.getDay()];
  // Vixie cron: если оба поля ограничены — достаточно любого; если одно `*` — решает другое.
  if (cron.dayOfMonthStar || cron.dayOfWeekStar) return dom && dow;
  return dom || dow;
}

/** Пять лет вперёд — с запасом для `0 0 29 2 *` и ему подобных. */
const SEARCH_LIMIT_MS = 5 * 366 * 24 * 60 * 60 * 1000;

/**
 * Следующее срабатывание строго после `after` (локальное время) или `null`, если его нет в
 * пределах пяти лет (`0 0 31 2 *`). Перебор идёт сеттерами локального времени: несуществующие
 * при переходе на летнее время минуты пропускаются, повторный час перехода на зимнее время не
 * посещается второй раз — двойного срабатывания нет.
 */
export function nextCronRun(cron: ParsedCron, after: Date): Date | null {
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = after.getTime() + SEARCH_LIMIT_MS;
  while (d.getTime() <= limit) {
    if (!cron.month[d.getMonth() + 1]) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(cron, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!cron.hour[d.getHours()]) {
      const hourBefore = d.getHours();
      d.setHours(hourBefore + 1, 0, 0, 0);
      // Переход на зимнее время: +1 час может вернуть тот же час — шагаем дальше по UTC.
      if (d.getHours() === hourBefore) d.setTime(d.getTime() + 60 * 60 * 1000);
      continue;
    }
    if (!cron.minute[d.getMinutes()]) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d;
  }
  return null;
}

/** Локальная метка минуты `YYYY-MM-DD HH:mm` — сверка «уже запускались в эту минуту». */
export function cronWallKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export type CronCatchUp = 'skip' | 'once';

/** Опоздание, после которого срабатывание считается пропущенным (сон, закрытое приложение). */
export const CRON_GRACE_MS = 5 * 60 * 1000;

export interface CronTickInput {
  cron: ParsedCron;
  now: Date;
  /** Запланированное срабатывание из состояния; нет — правило только что включено. */
  nextRunAt?: number;
  /** Метка минуты последнего запуска (`cronWallKey`). */
  lastWallKey?: string;
  catchUp: CronCatchUp;
  graceMs?: number;
}

export interface CronTickDecision {
  fire: boolean;
  /** Срабатывание опоздало больше допуска. */
  missed: boolean;
  /** Следующее запланированное срабатывание (мс) или `undefined`, если его нет. */
  nextRunAt?: number;
  /** Метка минуты, которой помечается запуск. */
  wallKey?: string;
}

/**
 * Решение одного тика планировщика. Пропущенные срабатывания не догоняются пачкой: при
 * `catchUp: 'once'` — один запуск, при `skip` — ни одного; следующее считается от «сейчас».
 */
export function planCronTick(input: CronTickInput): CronTickDecision {
  const { cron, now, catchUp } = input;
  const grace = input.graceMs ?? CRON_GRACE_MS;
  const upcoming = () => nextCronRun(cron, now)?.getTime();

  if (input.nextRunAt === undefined) return { fire: false, missed: false, nextRunAt: upcoming() };
  if (now.getTime() < input.nextRunAt) return { fire: false, missed: false, nextRunAt: input.nextRunAt };

  const scheduled = new Date(input.nextRunAt);
  const wallKey = cronWallKey(scheduled);
  const late = now.getTime() - input.nextRunAt;
  const missed = late > grace;
  const duplicate = input.lastWallKey === wallKey;
  const fire = !duplicate && (!missed || catchUp === 'once');
  return { fire, missed, nextRunAt: upcoming(), ...(fire ? { wallKey } : {}) };
}
