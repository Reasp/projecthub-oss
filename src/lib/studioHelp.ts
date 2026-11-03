import { cliOnlyCommands, STUDIO_COMMANDS, terminalCommandNames, type StudioCommandName } from './studioCliCommands';
import { rankFuzzy } from './composerCompletion';

/**
 * Поиск в окне `/help` вкладки Claude Code (TASK-287): команда подходит, если запрос есть в её имени, описании или
 * подсказке аргументов, без учёта регистра; ведущий `/` запроса не мешает.
 */
export function commandMatches(command: { name: string; description?: string; argumentHint?: string }, query: string): boolean {
  const q = query.trim().replace(/^\//, '').toLocaleLowerCase();
  if (!q) return true;
  return [command.name, command.description ?? '', command.argumentHint ?? ''].some((part) => part.toLocaleLowerCase().includes(q));
}

/** Текст, который клик по команде вставляет в поле ввода: имя и пробел, если команде нужны аргументы. */
export function commandPrefill(name: string, argumentHint: string): string {
  return argumentHint.trim() ? `/${name} ` : `/${name}`;
}

/** Кто выполняет команду из списка автодополнения `/` (TASK-300) — те же группы, что в окне `/help`. */
export type SlashGroup = 'studio' | 'cli' | 'terminal';

export interface SlashSuggestion {
  name: string;
  argumentHint: string;
  description: string;
  group: SlashGroup;
}

/** Команды Studio, которые работают у вкладки любого движка (decision-209): переписка — её сообщения, а не сессия CLI. */
const ANY_ENGINE_COMMANDS = new Set(['copy', 'export']);

/**
 * Подсказки `/` в поле ввода (TASK-300, decision-214). У вкладки Claude Code — команды Studio, команды CLI из ответа
 * `initialize` (с командами проекта и скиллами) и терминальные, каждая в одной группе, как в `/help`. У вкладки другого
 * движка — только команды Studio, которые не нужны CLI. Пустой запрос — порядок групп, иначе — нечёткий поиск по имени.
 */
export function slashSuggestions(opts: {
  cliTab: boolean;
  studioDescription: (name: StudioCommandName) => string;
  cliCommands: readonly { name: string; description: string; argumentHint: string }[];
  query: string;
  limit?: number;
}): SlashSuggestion[] {
  const studio: SlashSuggestion[] = STUDIO_COMMANDS.filter((c) => opts.cliTab || ANY_ENGINE_COMMANDS.has(c.name)).map((c) => ({
    name: c.name,
    argumentHint: c.args,
    description: opts.studioDescription(c.name),
    group: 'studio'
  }));
  const all = opts.cliTab
    ? [
        ...studio,
        ...cliOnlyCommands(opts.cliCommands).map((c): SlashSuggestion => ({ ...c, group: 'cli' })),
        ...terminalCommandNames().map((name): SlashSuggestion => ({ name, argumentHint: '', description: '', group: 'terminal' }))
      ]
    : studio;
  return rankFuzzy(all, opts.query, (s) => s.name, opts.limit ?? 300);
}
