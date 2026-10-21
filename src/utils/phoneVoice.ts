/**
 * Голосовое управление с телефона ([[decision-137]], TASK-179): каталог интентов и типы RPC `voice_command`. Общий
 * модуль ПК и телефона: ПК строит по каталогу промпт и разбирает ответ модели, телефон исполняет интенты.
 * Чистый модуль без Electron и React.
 */

export const PHONE_VOICE_INTENTS = [
  'prompt_agent',
  'create_task',
  'start_agent',
  'status',
  'pending',
  'approve',
  'reject',
  'read_answer',
  'create_project',
  'select',
  'repeat',
  'stop',
  'help',
  'unknown'
] as const;

export type PhoneVoiceIntent = (typeof PHONE_VOICE_INTENTS)[number];

/** Поля команды, которые модель может заполнить. Компьютер и проект есть у всех интентов. */
export type PhoneVoiceField = 'text' | 'title' | 'description' | 'taskId' | 'role' | 'name';

export interface PhoneVoiceIntentSpec {
  id: PhoneVoiceIntent;
  description: string;
  fields?: ReadonlyArray<{ name: PhoneVoiceField; required?: boolean; hint: string }>;
}

export const PHONE_VOICE_CATALOG: readonly PhoneVoiceIntentSpec[] = [
  {
    id: 'prompt_agent',
    description: 'дать агенту задание, поручение или вопрос в проекте («попроси агента…», «скажи агенту…», «пусть агент…»)',
    fields: [{ name: 'text', required: true, hint: 'текст поручения агенту своими словами пользователя, без имени компьютера и проекта' }]
  },
  {
    id: 'create_task',
    description: 'завести задачу в бэклоге проекта («создай задачу…», «запиши задачу…»)',
    fields: [
      { name: 'title', required: true, hint: 'короткий заголовок задачи' },
      { name: 'description', hint: 'подробности, если пользователь их сказал' }
    ]
  },
  {
    id: 'start_agent',
    description: 'запустить агента на существующей задаче бэклога по её номеру («запусти агента на задаче 12»)',
    fields: [
      { name: 'taskId', required: true, hint: 'номер задачи в виде TASK-12' },
      { name: 'role', hint: 'роль агента, если названа' }
    ]
  },
  { id: 'status', description: 'вопрос о состоянии: что делают агенты, что запущено, как дела на компьютере или в проекте' },
  { id: 'pending', description: 'что ждёт решения или подтверждения человека' },
  { id: 'approve', description: 'разрешить, одобрить ближайший запрос подтверждения агента' },
  { id: 'reject', description: 'отклонить, запретить ближайший запрос подтверждения агента' },
  { id: 'read_answer', description: 'прочитать последний ответ агента («что ответил агент»)' },
  {
    id: 'create_project',
    description: 'создать новый проект на компьютере («создай проект X на компьютере Y»)',
    fields: [{ name: 'name', required: true, hint: 'имя нового проекта, одно-три слова' }]
  },
  { id: 'select', description: 'перейти к компьютеру или проекту без действия («переключись на…», «работаем с…»)' },
  { id: 'repeat', description: 'повторить последний ответ' },
  { id: 'stop', description: 'замолчать, хватит, выключить голосовой режим' },
  { id: 'help', description: 'что ты умеешь, какие команды есть' },
  { id: 'unknown', description: 'фраза не команда: разговор с кем-то рядом, шум, обрывок' }
];

/** Сколько компьютеров и проектов на компьютер уходит в промпт. */
export const PHONE_VOICE_MAX_COMPUTERS = 8;
export const PHONE_VOICE_MAX_PROJECTS = 40;
export const PHONE_VOICE_MAX_TEXT = 2000;

export interface PhoneVoiceComputer {
  name: string;
  projects: string[];
}

/** Параметры RPC `voice_command`. */
export interface PhoneVoiceCommandRequest {
  text: string;
  language: 'ru' | 'en';
  computers: PhoneVoiceComputer[];
  /** Компьютер и проект прошлой команды: к ним относится фраза, где они не названы. */
  current?: { computer?: string; project?: string };
  /** Телефон переспросил компьютер или проект: ответ пользователя — это имя. */
  awaiting?: 'computer' | 'project';
}

/** Ответ RPC `voice_command`. Имена компьютера и проекта — только из присланного списка. */
export interface PhoneVoiceCommand {
  intent: PhoneVoiceIntent;
  computer?: string;
  project?: string;
  /** Компьютер или проект назван во фразе, но в списке его нет: телефон скажет об этом, а не угадает. */
  unknownComputer?: string;
  unknownProject?: string;
  text?: string;
  title?: string;
  description?: string;
  taskId?: string;
  role?: string;
  name?: string;
  confidence: number;
  error?: string;
}

export function isPhoneVoiceIntent(value: unknown): value is PhoneVoiceIntent {
  return typeof value === 'string' && (PHONE_VOICE_INTENTS as readonly string[]).includes(value);
}

export function phoneVoiceSpec(id: PhoneVoiceIntent): PhoneVoiceIntentSpec | undefined {
  return PHONE_VOICE_CATALOG.find((s) => s.id === id);
}
