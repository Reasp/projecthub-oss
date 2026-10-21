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
  'list_tasks',
  'move_task',
  'review_accept',
  'review_return',
  'run_action',
  'stop_process',
  'stop_agent',
  'agent_output',
  'git_status',
  'git_commit',
  'git_push',
  'git_pull',
  'usage',
  'inbox',
  'open_screen',
  'repeat',
  'stop',
  'help',
  'unknown'
] as const;

export type PhoneVoiceIntent = (typeof PHONE_VOICE_INTENTS)[number];

/** Поля команды, которые модель может заполнить. Компьютер и проект есть у всех интентов. */
export type PhoneVoiceField =
  | 'text'
  | 'title'
  | 'description'
  | 'taskId'
  | 'role'
  | 'name'
  | 'status'
  | 'comment'
  | 'action'
  | 'process'
  | 'message'
  | 'session'
  | 'screen';

/** Экраны телефона, которые открываются голосом. */
export const PHONE_VOICE_SCREENS = ['inbox', 'tasks', 'docs', 'processes', 'studio', 'computers'] as const;
export type PhoneVoiceScreen = (typeof PHONE_VOICE_SCREENS)[number];

/** Статусы Backlog.md, в которые задача переводится голосом. */
export const PHONE_VOICE_TASK_STATUSES = ['To Do', 'In Progress', 'Review', 'Done'] as const;

export interface PhoneVoiceIntentSpec {
  id: PhoneVoiceIntent;
  description: string;
  fields?: ReadonlyArray<{ name: PhoneVoiceField; required?: boolean; hint: string }>;
}

export const PHONE_VOICE_CATALOG: readonly PhoneVoiceIntentSpec[] = [
  {
    id: 'prompt_agent',
    description: 'дать агенту задание, поручение или вопрос в проекте («попроси агента…», «скажи агенту…», «пусть агент…»)',
    fields: [
      { name: 'text', required: true, hint: 'текст поручения агенту своими словами пользователя, без имени компьютера и проекта' },
      { name: 'session', hint: '"new", если просят новую сессию или новый чат; иначе не заполняй — продолжится прошлая голосовая сессия проекта' }
    ]
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
  {
    id: 'list_tasks',
    description: 'какие задачи в проекте: в работе, в ревью, к выполнению («какие задачи в работе», «что в ревью»)',
    fields: [{ name: 'status', hint: 'один из: To Do, In Progress, Review, Done; не заполняй, если статус не назван' }]
  },
  {
    id: 'move_task',
    description: 'перевести задачу в другой статус («переведи задачу 12 в работу», «закрой задачу 5»)',
    fields: [
      { name: 'taskId', required: true, hint: 'номер задачи в виде TASK-12' },
      { name: 'status', required: true, hint: 'один из: To Do, In Progress, Review, Done' }
    ]
  },
  {
    id: 'review_accept',
    description: 'принять задачу из ревью, работа агента устраивает («прими задачу 12», «ревью ок»)',
    fields: [{ name: 'taskId', hint: 'номер задачи в виде TASK-12, если назван' }]
  },
  {
    id: 'review_return',
    description: 'вернуть задачу из ревью агенту на доработку с замечанием',
    fields: [
      { name: 'taskId', hint: 'номер задачи в виде TASK-12, если назван' },
      { name: 'comment', required: true, hint: 'что исправить, словами пользователя' }
    ]
  },
  {
    id: 'run_action',
    description: 'запустить проект, тесты или деплой («запусти тесты», «задеплой», «запусти проект»)',
    fields: [{ name: 'action', required: true, hint: 'run — запуск проекта, test — тесты, deploy — деплой, или имя своего действия' }]
  },
  {
    id: 'stop_process',
    description: 'остановить запущенный процесс проекта (dev-сервер, вотчер)',
    fields: [{ name: 'process', hint: 'имя процесса, если названо' }]
  },
  { id: 'stop_agent', description: 'остановить работающего агента в проекте («останови агента», «хватит, отмени»)' },
  {
    id: 'agent_output',
    description: 'что пишет или делает агент на задаче прямо сейчас («что там агент на задаче 12»)',
    fields: [{ name: 'taskId', hint: 'номер задачи в виде TASK-12, если назван' }]
  },
  { id: 'git_status', description: 'состояние git проекта: ветка, изменённые файлы' },
  {
    id: 'git_commit',
    description: 'закоммитить изменения проекта',
    fields: [{ name: 'message', required: true, hint: 'сообщение коммита словами пользователя' }]
  },
  { id: 'git_push', description: 'отправить коммиты проекта (git push)' },
  { id: 'git_pull', description: 'подтянуть изменения проекта (git pull)' },
  { id: 'usage', description: 'лимиты и расход Claude: сколько осталось' },
  { id: 'inbox', description: 'что во «Входящих»: задачи в ревью, подтверждения, задачи агентов' },
  {
    id: 'open_screen',
    description: 'открыть экран приложения («открой задачи», «покажи документы»)',
    fields: [{ name: 'screen', required: true, hint: 'один из: inbox, tasks, docs, processes, studio, computers' }]
  },
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
  status?: string;
  comment?: string;
  action?: string;
  process?: string;
  message?: string;
  session?: string;
  screen?: string;
  confidence: number;
  error?: string;
}

export function isPhoneVoiceIntent(value: unknown): value is PhoneVoiceIntent {
  return typeof value === 'string' && (PHONE_VOICE_INTENTS as readonly string[]).includes(value);
}

export function phoneVoiceSpec(id: PhoneVoiceIntent): PhoneVoiceIntentSpec | undefined {
  return PHONE_VOICE_CATALOG.find((s) => s.id === id);
}
