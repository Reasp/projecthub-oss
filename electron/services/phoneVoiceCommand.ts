/**
 * Разбор голосовой команды телефона на ПК ([[decision-137]] п. 3–4, TASK-179.1): параметры RPC `voice_command`,
 * промпт модели назначения `voice.classify` и разбор её ответа. ПК только разбирает фразу — исполняет телефон: он
 * видит весь флот, а этот ПК — только себя.
 *
 * Чистый модуль без Electron — импортируется unit-тестами напрямую.
 */
import {
  PHONE_VOICE_CATALOG,
  PHONE_VOICE_MAX_COMPUTERS,
  PHONE_VOICE_MAX_PROJECTS,
  PHONE_VOICE_MAX_TEXT,
  isPhoneVoiceIntent,
  phoneVoiceSpec,
  type PhoneVoiceCommand,
  type PhoneVoiceCommandRequest,
  type PhoneVoiceComputer
} from '../../src/utils/phoneVoice.js';
import { extractJsonObject } from './reviewerPrompt.js';

const NAME_MAX = 120;

function cleanName(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, NAME_MAX) : '';
}

/** Параметры от устройства: обрезаны по размеру, мусор отброшен. Пустой текст — ошибка. */
export function parsePhoneVoiceRequest(params: unknown): PhoneVoiceCommandRequest {
  const p = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  const text = typeof p.text === 'string' ? p.text.trim().slice(0, PHONE_VOICE_MAX_TEXT) : '';
  if (!text) throw new Error('voice_command: пустой текст');
  const computers: PhoneVoiceComputer[] = [];
  for (const raw of Array.isArray(p.computers) ? p.computers.slice(0, PHONE_VOICE_MAX_COMPUTERS) : []) {
    const c = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const name = cleanName(c.name);
    if (!name) continue;
    const projects = (Array.isArray(c.projects) ? c.projects : []).map(cleanName).filter(Boolean).slice(0, PHONE_VOICE_MAX_PROJECTS);
    computers.push({ name, projects });
  }
  const cur = p.current && typeof p.current === 'object' ? (p.current as Record<string, unknown>) : {};
  const current = { computer: cleanName(cur.computer) || undefined, project: cleanName(cur.project) || undefined };
  return {
    text,
    language: p.language === 'en' ? 'en' : 'ru',
    computers,
    ...(current.computer || current.project ? { current } : {}),
    ...(p.awaiting === 'computer' || p.awaiting === 'project' ? { awaiting: p.awaiting } : {})
  };
}

export const PHONE_VOICE_RESPONSE_SCHEMA =
  '{"intent": "идентификатор", "computer": "имя из списка или пусто", "project": "имя из списка или пусто", "confidence": 0.0, ...поля интента}';

/**
 * Примеры на вымышленном флоте: слабые локальные модели без них принимают реплику человеку рядом за команду и
 * подменяют неизвестный проект похожим из списка.
 */
const PHONE_VOICE_EXAMPLES = [
  'Флот примеров: «Office-PC» (проекты Shop, Blog), «home-laptop.local» (проекты Blog, Notes).',
  '«на ноутбуке в нотсах попроси агента обновить зависимости» → {"intent":"prompt_agent","computer":"home-laptop.local","project":"Notes","text":"обновить зависимости","confidence":0.9}',
  '«что там с магазином» → {"intent":"status","project":"Shop","confidence":0.8}',
  '«попроси агента в проекте Ракета написать тесты» → {"intent":"prompt_agent","unknownProject":"Ракета","text":"написать тесты","confidence":0.8}',
  '«создай проект телеграм бот на офисном» → {"intent":"create_project","computer":"Office-PC","name":"телеграм бот","confidence":0.9}',
  '«Саша, подожди минутку» → {"intent":"unknown","confidence":0.9}',
  '«ну и погода сегодня» → {"intent":"unknown","confidence":0.9}'
].join('\n');

/** Промпт разбора. Русский — как у остальных служебных промптов проекта. */
export function buildPhoneVoicePrompt(req: PhoneVoiceCommandRequest): string {
  const sections: string[] = [];
  sections.push(
    'Ты разбираешь голосовые команды, которые владелец говорит телефону. Телефон управляет несколькими его ' +
      'компьютерами, на каждом — проекты с AI-агентами. Определи, что пользователь хочет, на каком компьютере и в ' +
      'каком проекте. Отвечай строго одним JSON-объектом, без пояснений и без markdown-ограды.'
  );

  const intents = PHONE_VOICE_CATALOG.map((spec) => {
    const fields = spec.fields?.length ? ` | поля: ${spec.fields.map((f) => `"${f.name}"${f.required ? ' (обязательно)' : ''} — ${f.hint}`).join('; ')}` : '';
    return `${spec.id} — ${spec.description}${fields}`;
  });
  sections.push(`## Интенты\n${intents.join('\n')}`);

  const fleet = req.computers.length
    ? req.computers.map((c) => `- ${c.name}: ${c.projects.length ? c.projects.join(', ') : 'проектов нет'}`).join('\n')
    : 'Список пуст.';
  sections.push(`## Компьютеры и их проекты\n${fleet}`);

  const context: string[] = [];
  if (req.current?.computer) context.push(`Текущий компьютер: ${req.current.computer}.`);
  if (req.current?.project) context.push(`Текущий проект: ${req.current.project}.`);
  if (req.awaiting === 'computer') context.push('Телефон только что спросил, на каком компьютере: фраза — ответ на этот вопрос, intent "select".');
  if (req.awaiting === 'project') context.push('Телефон только что спросил, в каком проекте: фраза — ответ на этот вопрос, intent "select".');
  if (context.length) sections.push(`## Контекст\n${context.join('\n')}`);

  sections.push(`## Примеры\n${PHONE_VOICE_EXAMPLES}`);

  sections.push(`## Фраза пользователя${req.language === 'en' ? ' (язык фразы: английский)' : ''}\n${req.text}`);

  sections.push(
    '## Формат ответа\n' +
      PHONE_VOICE_RESPONSE_SCHEMA +
      '\n\n`intent` — ровно один идентификатор из списка. `computer` и `project` — только если они названы во фразе, ' +
      'и только точным именем из списка выше: распознаватель речи пишет имена по-русски и с ошибками («макбук», ' +
      '«кьют монстерс»), сопоставь их со списком. Названный компьютер или проект, которого в списке нет, верни в ' +
      '`unknownComputer` или `unknownProject`. Не названы — оставь пустыми, телефон возьмёт текущие. Для ' +
      '`create_project` имя нового проекта — в поле `name`, а не в `project`. Остальные поля — только описанные у ' +
      'выбранного интента. `confidence` — число от 0 до 1. Фраза не похожа на команду — intent "unknown", ничего не ' +
      'выдумывай. Саму команду не выполняй.'
  );
  return sections.join('\n\n');
}

/** Сравнение имён без регистра, пунктуации и суффикса `.local`. */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\.local$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function pick(list: readonly string[], said: string): string | undefined {
  const exact = list.find((n) => n === said);
  if (exact) return exact;
  const key = nameKey(said);
  return key ? list.find((n) => nameKey(n) === key) : undefined;
}

/** «12», «task 12», «TASK-12.3» → «TASK-12», «TASK-12.3». */
export function normalizeTaskId(value: string): string | undefined {
  const m = /(?:task[\s-]*)?(\d+(?:\.\d+)*)/i.exec(value);
  return m ? `TASK-${m[1]}` : undefined;
}

function toConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.5;
  const scaled = value > 1 ? value / (value > 10 ? 100 : 10) : value;
  return Math.min(1, Math.max(0, scaled));
}

function text(value: unknown, max = PHONE_VOICE_MAX_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim().slice(0, max);
  return t || undefined;
}

const UNKNOWN: PhoneVoiceCommand = { intent: 'unknown', confidence: 0 };

/**
 * Ответ модели → команда. Имена компьютера и проекта сверяются со списком запроса: не нашлось — уходят в
 * `unknownComputer`/`unknownProject`. Нет обязательного поля интента — `unknown`: исполнять нечего.
 */
export function parsePhoneVoiceResponse(raw: string, req: PhoneVoiceCommandRequest): PhoneVoiceCommand {
  const json = extractJsonObject((raw ?? '').trim());
  if (!json) return { ...UNKNOWN, error: 'В ответе модели нет JSON-объекта' };
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...UNKNOWN, error: 'Ответ модели — не объект' };
    obj = parsed as Record<string, unknown>;
  } catch (err) {
    return { ...UNKNOWN, error: `JSON не разобрался: ${err instanceof Error ? err.message : String(err)}` };
  }
  const intent = typeof obj.intent === 'string' ? obj.intent.trim().toLowerCase() : '';
  if (!isPhoneVoiceIntent(intent) || intent === 'unknown') return { ...UNKNOWN, ...(intent && intent !== 'unknown' ? { error: `Неизвестный интент ${intent}` } : {}) };

  const cmd: PhoneVoiceCommand = { intent, confidence: toConfidence(obj.confidence) };

  const computerSaid = text(obj.computer, NAME_MAX);
  const computer = computerSaid ? pick(req.computers.map((c) => c.name), computerSaid) : undefined;
  if (computer) cmd.computer = computer;
  const unknownComputer = text(obj.unknownComputer, NAME_MAX) ?? (computerSaid && !computer ? computerSaid : undefined);
  if (unknownComputer) cmd.unknownComputer = unknownComputer;

  const projectSaid = text(obj.project, NAME_MAX);
  // Проект ищется на названном компьютере, иначе — на текущем. Компьютер не назван, а проекта на текущем нет —
  // ищем по флоту: проект ровно на одном компьютере однозначен, модели в таком случае часто опускают компьютер.
  const scope = req.computers.find((c) => c.name === (computer ?? req.current?.computer));
  let project = projectSaid && scope ? pick(scope.projects, projectSaid) : undefined;
  if (projectSaid && !project && !computer) {
    const owners = req.computers.filter((c) => pick(c.projects, projectSaid));
    if (owners.length === 1) {
      cmd.computer = owners[0].name;
      project = pick(owners[0].projects, projectSaid);
    }
  }
  if (project) cmd.project = project;
  const unknownProject = text(obj.unknownProject, NAME_MAX) ?? (projectSaid && !project ? projectSaid : undefined);
  if (unknownProject) cmd.unknownProject = unknownProject;

  for (const field of phoneVoiceSpec(intent)?.fields ?? []) {
    let value = text(obj[field.name], field.name === 'title' || field.name === 'name' || field.name === 'role' ? NAME_MAX : PHONE_VOICE_MAX_TEXT);
    if (value && field.name === 'taskId') value = normalizeTaskId(value);
    if (value && field.name === 'name' && /[\\/]|\.\./.test(value)) value = undefined;
    if (value) cmd[field.name] = value;
    else if (field.required) return { ...UNKNOWN, error: `Интент ${intent} без поля ${field.name}` };
  }
  return cmd;
}
