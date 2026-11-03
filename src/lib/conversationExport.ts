/**
 * Копирование ответа и экспорт переписки вкладки Agents Studio (TASK-288, decision-209) — чистые функции без React и
 * Electron. Переписку Studio собирает сама из сообщений вкладки, поэтому экспорт одинаков для всех движков: Claude Code,
 * API и серверов моделей. Расшифровку самого Claude Code (`/export` терминала) даёт CLI — это отдельный путь в main.
 */
import type { AIMessage, AIToolCall } from '../types/electron';
import { toolLabel, toolSubject } from './agentToolView';

export interface ConversationExportLabels {
  user: string;
  assistant: string;
  system: string;
  /** Подпись свёрнутого списка шагов: `{count}` — их число. */
  tools: string;
  thinking: string;
  error: string;
  /** Строка под заголовком: `{date}` — время экспорта. */
  exported: string;
}

export interface ConversationExportInput {
  title: string;
  messages: readonly AIMessage[];
  labels: ConversationExportLabels;
  exportedAt: Date;
  /** Движок или модель вкладки — в строку под заголовком. */
  agent?: string;
}

/** Ответы модели с текстом, от последнего к первому. */
function repliesNewestFirst(messages: readonly AIMessage[]): AIMessage[] {
  return messages.filter((m) => m.role === 'assistant' && m.content.trim()).reverse();
}

/**
 * Текст ответа для `/copy [N]`: `N` — какой с конца (1 — последний), как у `/copy` Claude Code. Ответ, который ещё
 * пишется, не считается: копируется то, что модель уже договорила.
 */
export function replyToCopy(messages: readonly AIMessage[], n = 1, streaming = false): string | null {
  const replies = copyableReplies(messages, streaming);
  if (!Number.isInteger(n) || n < 1 || n > replies.length) return null;
  return replies[n - 1].content.trim();
}

/** Сколько ответов можно скопировать — для подсказки, если номера после `/copy` нет. */
export function replyCount(messages: readonly AIMessage[], streaming = false): number {
  return copyableReplies(messages, streaming).length;
}

function copyableReplies(messages: readonly AIMessage[], streaming: boolean): AIMessage[] {
  const list = streaming && messages.length && messages[messages.length - 1].role === 'assistant' ? messages.slice(0, -1) : messages;
  return repliesNewestFirst(list);
}

/** Число после `/copy`: пусто — 1; не число — `null`, Studio подскажет, как писать команду. */
export function copyArgument(rest: string): number | null {
  const arg = rest.trim();
  if (!arg) return 1;
  return /^\d{1,4}$/.test(arg) && Number(arg) >= 1 ? Number(arg) : null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Местное время `YYYY-MM-DD HH:mm`. */
export function formatExportTime(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Код в строке Markdown: ограничитель длиннее самой длинной серии обратных кавычек внутри. */
export function inlineCode(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function toolLine(call: AIToolCall): string {
  const subject = toolSubject(call.name, call.args);
  const status = call.status === 'rejected' || call.status === 'error' ? ` (${call.status})` : '';
  return `- ${inlineCode(toolLabel(call.name))}${subject ? ` — ${inlineCode(subject)}` : ''}${status}`;
}

function messageTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '' : ` · ${formatExportTime(date)}`;
}

function details(summary: string, body: string): string {
  return `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;
}

/**
 * Переписка вкладки в Markdown: заголовок вкладки, реплики по порядку с временем, у ответа — рассуждения и шаги агента
 * свёрнутыми блоками `<details>` (GitHub, Obsidian и просмотрщик ProjectHub их понимают), ошибка — цитатой.
 */
export function conversationMarkdown(input: ConversationExportInput): string {
  const { labels } = input;
  const out: string[] = [`# ${input.title.trim() || labels.assistant}`, ''];
  const exported = labels.exported.replace('{date}', formatExportTime(input.exportedAt));
  out.push(`_${input.agent ? `${input.agent} · ` : ''}${exported}_`, '');
  for (const msg of input.messages) {
    if (msg.role === 'tool') continue;
    const who = msg.role === 'user' ? labels.user : msg.role === 'system' ? labels.system : labels.assistant;
    const parts: string[] = [];
    if (msg.thought?.trim()) parts.push(details(labels.thinking, msg.thought.trim()));
    if (msg.content.trim()) parts.push(msg.content.trim());
    // Вложения реплики (TASK-289) — путями от корня проекта: файлы лежат в каталоге вложений вкладки.
    if (msg.attachments?.length) parts.push(msg.attachments.map((at) => `- 📎 \`${at.path}\``).join('\n'));
    const calls = msg.toolCalls ?? [];
    if (calls.length) parts.push(details(labels.tools.replace('{count}', String(calls.length)), calls.map(toolLine).join('\n')));
    if (msg.error?.trim()) parts.push(`> **${labels.error}:** ${msg.error.trim().replace(/\r?\n/g, '\n> ')}`);
    if (!parts.length) continue;
    out.push(`## ${who}${messageTime(msg.timestamp)}`, '', parts.join('\n\n'), '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

const MAX_NAME = 60;

/** Имя файла по умолчанию: `2026-11-03-1420-заголовок-вкладки.md` — дата впереди, чтобы файлы ложились по порядку. */
export function exportFileName(title: string, date: Date, ext: 'md' | 'txt' = 'md'): string {
  const slug = title
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME)
    .replace(/-+$/, '');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `${stamp}-${slug || 'conversation'}.${ext}`;
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * Имя после `/export <имя>`: только имя файла, без каталога — файл всё равно сохраняется через системный диалог, имя
 * лишь подставляется в него. Без расширения — `.md`; `.txt` оставляется (для Claude Code — его расшифровка).
 */
export function exportArgument(rest: string): string | undefined {
  const raw = rest.trim().replace(/^["']|["']$/g, '');
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex -- управляющие символы в имени файла недопустимы, их и убираем
  const clean = base.replace(/[<>:"|?*\0-\x1f]/g, '').replace(/[. ]+$/, '').trim();
  if (!clean || clean.startsWith('.') || RESERVED.test(clean.replace(/\..*$/, ''))) return undefined;
  const name = clean.slice(0, 120);
  return /\.(md|markdown|txt)$/i.test(name) ? name : `${name}.md`;
}
