/**
 * Тексты статуса агента и карточек HITL для человека (TASK-204, правило 25): main-процесс отдаёт код и параметры,
 * текст берётся из словарей i18n. `lastMessage`, `title` и `details` от main — запасной текст для запросов без кода
 * (внешние MCP-клиенты, хуки терминала, старый main-процесс).
 *
 * Чистый модуль без React — покрыт unit-тестами.
 */
import type { AgentStatusCode, ApprovalRequest, HitlTextCode, ProjectAgentStatus, QuestionData } from '../types/electron';
import type { AppErrorLabels } from '../i18n/appErrorText';
import { appFailureText } from './appErrorText';

/** Шаблоны с подстановкой {detail}: команда для `executing`, текст ошибки для `failed`. */
export type AgentStatusLabels = Record<AgentStatusCode, string>;

export interface HitlTextLabels {
  /** Заголовок карточки без цели: цель идёт после двоеточия. */
  titles: Record<HitlTextCode, string>;
  /** Пояснение по умолчанию с подстановкой {target}. */
  details: Record<HitlTextCode, string>;
  /** Вопрос карточки чтения. В подписи «запретить» обязано быть «deny» или «запретить»: по ней main понимает отказ. */
  readQuestion: { title: string; allow: string; deny: string };
}

const fill = (template: string, vars: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (all, key: string) => vars[key] ?? all);

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
  const title = `${key.agent ? `${key.agent}: ` : ''}${labels.titles[key.code]}${target ? `: ${target}` : ''}`;
  const details = key.ownDetails ? req.details : fill(labels.details[key.code], { target });
  if (key.code === 'question') return { title, details, questionData: req.questionData && { ...req.questionData, title: labels.titles.question } };
  if ((key.code !== 'read' && key.code !== 'read_outside') || !req.questionData) return { title, details, questionData: req.questionData };
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
