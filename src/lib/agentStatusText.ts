/**
 * Тексты статуса агента и карточек HITL для человека (TASK-204, правило 25): main-процесс отдаёт код и параметры,
 * текст берётся из словарей i18n. `lastMessage`, `title` и `details` от main — запасной текст для запросов без кода
 * (внешние MCP-клиенты, хуки терминала, старый main-процесс).
 *
 * Чистый модуль без React — покрыт unit-тестами.
 */
import type { AgentStatusCode, ApprovalRequest, HitlTextCode, HitlTextLine, ProjectAgentStatus, QuestionData } from '../types/electron';
import type { AppErrorLabels } from '../i18n/appErrorText';
import { appFailureText } from './appErrorText';

/** Шаблоны с подстановкой {detail}: команда для `executing`, текст ошибки для `failed`. */
export type AgentStatusLabels = Record<AgentStatusCode, string>;

/** Вопрос карточки с вариантами (TASK-202.8): заголовок, подзаголовок и подписи вариантов по id. */
export interface HitlQuestionLabels {
  title: string;
  subtitle?: string;
  options: Record<string, { label: string; description?: string }>;
}

export interface HitlTextLabels {
  /** Заголовок карточки без цели: цель идёт после двоеточия, если шаблон не ставит {target} сам. */
  titles: Record<HitlTextCode, string>;
  /** Пояснение по умолчанию с подстановкой {target} и параметров кода. */
  details: Record<HitlTextCode, string>;
  /** Вопрос карточки чтения. В подписи «запретить» обязано быть «deny» или «запретить»: по ней main понимает отказ. */
  readQuestion: { title: string; allow: string; deny: string };
  /** Вопросы с вариантами по коду карточки (TASK-202.8). */
  questions: Partial<Record<HitlTextCode, HitlQuestionLabels>>;
  /** Шаблоны строк пояснения `HitlTextKey.lines` (TASK-202.8). */
  lines: Record<string, string>;
}

const fill = (template: string, vars: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (all, key: string) => vars[key] ?? all);

/** Строка пояснения по словарю; `null` — словарь не знает код строки или вложенной строки. */
function renderLine(line: HitlTextLine, lines: Record<string, string>): string | null {
  const template = lines[line.code];
  if (template === undefined) return null;
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(line.params ?? {})) {
    if (typeof value === 'string') {
      vars[name] = value;
      continue;
    }
    const parts = (Array.isArray(value) ? value : [value]).map((part) => renderLine(part, lines));
    if (parts.some((part) => part === null)) return null;
    vars[name] = parts.join(', ');
  }
  return fill(template, vars);
}

/** Пояснение строками словаря; `null` — хоть одна строка неизвестна, показывается запасной текст хоста. */
export function renderHitlLines(lines: HitlTextLine[], templates: Record<string, string>): string | null {
  const out: string[] = [];
  for (const line of lines) {
    const text = renderLine(line, templates);
    if (text === null) return null;
    out.push(text);
  }
  return out.join('\n');
}

export interface HitlText {
  title: string;
  details?: string;
  questionData?: QuestionData;
}

/** Заголовок, пояснение и вопрос карточки HITL на языке интерфейса. */
export function describeHitlRequest(
  req: Pick<ApprovalRequest, 'title' | 'details' | 'questionData' | 'textKey'>,
  labels: HitlTextLabels
): HitlText {
  const key = req.textKey;
  if (!key || !labels.titles[key.code]) return { title: req.title, details: req.details, questionData: req.questionData };
  const target = key.target ?? '';
  const vars = { ...key.params, target };
  const template = labels.titles[key.code];
  const suffix = target && !template.includes('{target}') ? `: ${target}` : '';
  const title = `${key.agent ? `${key.agent}: ` : ''}${fill(template, vars)}${suffix}`;
  const lines = key.lines?.length ? renderHitlLines(key.lines, labels.lines) : undefined;
  const details = lines !== undefined ? lines ?? req.details : key.ownDetails ? req.details : fill(labels.details[key.code], vars);
  if (key.code === 'question' || key.code === 'assistant_question') {
    return { title, details, questionData: req.questionData && { ...req.questionData, title: labels.titles[key.code] } };
  }
  if (!req.questionData) return { title, details };
  if (key.code === 'read' || key.code === 'read_outside' || key.code === 'read_excluded') {
    const optionLabel: Record<string, string> = { allow: labels.readQuestion.allow, deny: labels.readQuestion.deny };
    return {
      title,
      details,
      questionData: {
        ...req.questionData,
        title: labels.readQuestion.title,
        subtitle: fill(labels.details.read, { target }),
        options: req.questionData.options.map((o) => ({ ...o, label: optionLabel[o.id] ?? o.label }))
      }
    };
  }
  const question = labels.questions[key.code];
  if (!question) return { title, details, questionData: req.questionData };
  return {
    title,
    details,
    questionData: {
      ...req.questionData,
      title: fill(question.title, vars),
      ...(question.subtitle !== undefined ? { subtitle: fill(question.subtitle, vars) } : {}),
      options: req.questionData.options.map((o) => {
        const known = question.options[o.id];
        return known ? { ...o, label: known.label, description: known.description } : o;
      })
    }
  };
}

/**
 * id варианта по ответу человека (TASK-202.8): окно и голос присылают подпись варианта на языке своего интерфейса,
 * поэтому main сверяет её с подписями всех словарей. `undefined` — ответ не совпал ни с одним вариантом.
 */
export function hitlOptionId(code: HitlTextCode, answer: string | undefined, dictionaries: HitlTextLabels[]): string | undefined {
  const text = (answer ?? '').trim();
  if (!text) return undefined;
  for (const labels of dictionaries) {
    const options = labels.questions[code]?.options ?? {};
    for (const [id, option] of Object.entries(options)) {
      if (text === id || text === option.label) return id;
    }
  }
  return undefined;
}

/**
 * Строка статуса агента: при ожидании решения — заголовок карточки, иначе сообщение по коду, иначе `lastMessage`.
 * Пустая строка — у статуса нет текста, интерфейс показывает свой текст по умолчанию.
 */
export function describeAgentStatus(
  status: Pick<ProjectAgentStatus, 'status' | 'lastMessage' | 'messageKey' | 'pendingApproval'>,
  labels: AgentStatusLabels,
  hitlLabels: HitlTextLabels,
  appErrors?: AppErrorLabels
): string {
  if (status.status === 'waiting_approval' && status.pendingApproval) return describeHitlRequest(status.pendingApproval, hitlLabels).title;
  const key = status.messageKey;
  if (key && labels[key.code]) {
    const detail = appErrors && key.detail ? appFailureText({ error: key.detail, errorKey: key.detailKey }, appErrors) : key.detail ?? '';
    return fill(labels[key.code], { detail }).trim();
  }
  return status.lastMessage ?? '';
}
