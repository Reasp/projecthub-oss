/**
 * Запрос HITL кодом (TASK-202.8, decision-160 п. 9–12): источник кладёт в запрос `textKey`, а `title`, `details` и
 * `questionData` собираются тем же словарём по-английски — запасной текст для журнала, аудита, MCP-клиентов и
 * клиентов, которые код не знают. Окно и телефон показывают запрос на своём языке по `textKey`.
 *
 * Чистый модуль без Electron.
 */
import { describeHitlRequest, hitlOptionId } from '../../src/lib/agentStatusText.js';
import { hitlRequestTextEn, hitlRequestTextRu } from '../../src/i18n/hitlRequestText.js';
import type { HitlTextCode, HitlTextKey, QuestionData } from './hitlTypes.js';

export interface KeyedHitlText {
  title: string;
  details?: string;
  questionData?: QuestionData;
  textKey: HitlTextKey;
}

export interface KeyedHitlExtra {
  /** Пояснение агента или хоста при `ownDetails`. */
  details?: string;
  /** Варианты вопроса по id: подписи берутся из словаря (`questions` кода или вопрос чтения). */
  options?: string[];
  isMultiSelect?: boolean;
  allowOther?: boolean;
}

/** Поля запроса по коду: английский текст из словаря и сам код. */
export function keyedHitlText(textKey: HitlTextKey, extra: KeyedHitlExtra = {}): KeyedHitlText {
  const questionData: QuestionData | undefined = extra.options
    ? {
        title: '',
        options: extra.options.map((id) => ({ id, label: id })),
        isMultiSelect: extra.isMultiSelect ?? false,
        allowOther: extra.allowOther ?? false
      }
    : undefined;
  const text = describeHitlRequest({ title: '', details: extra.details, questionData, textKey }, hitlRequestTextEn);
  return {
    title: text.title,
    ...(text.details ? { details: text.details } : {}),
    ...(text.questionData ? { questionData: text.questionData } : {}),
    textKey
  };
}

/** Ответ на вопрос чтения — отказ: id `deny`, подпись «запретить» любого словаря или слово deny в ответе. */
export function readAnswerDenied(answer: string | undefined): boolean {
  const text = (answer ?? '').trim().toLowerCase();
  return text.includes('deny') || [hitlRequestTextEn, hitlRequestTextRu].some((labels) => text === labels.readQuestion.deny.toLowerCase());
}

/** id варианта по ответу человека: подпись на любом языке словаря или сам id. */
export function answeredOption(code: HitlTextCode, answer: string | undefined): string | undefined {
  return hitlOptionId(code, answer, [hitlRequestTextEn, hitlRequestTextRu]);
}
