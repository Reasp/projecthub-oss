/**
 * История промптов в поле ввода Agents Studio (TASK-300, decision-214): ↑/↓ листают реплики человека, как в
 * терминальном Claude Code. Источник — сами вкладки проекта (они и так хранятся локально), отдельного файла истории нет.
 */

interface HistorySession {
  id: string;
  messages?: readonly { role: string; content: string; timestamp?: string }[];
}

export const PROMPT_HISTORY_LIMIT = 300;

/**
 * Промпты для ↑: сначала реплики текущей вкладки от новой к старой, затем реплики других вкладок проекта по времени.
 * Пустые и повторы (без учёта пробелов по краям) отбрасываются — остаётся более новое вхождение.
 */
export function projectPromptHistory(sessions: readonly HistorySession[], currentId: string | undefined, limit = PROMPT_HISTORY_LIMIT): string[] {
  const own: string[] = [];
  const others: { text: string; time: number; order: number }[] = [];
  let order = 0;
  for (const session of sessions) {
    for (const m of session.messages ?? []) {
      if (m.role !== 'user' || typeof m.content !== 'string' || !m.content.trim()) continue;
      if (session.id === currentId) own.push(m.content);
      else others.push({ text: m.content, time: Date.parse(m.timestamp ?? '') || 0, order: order++ });
    }
  }
  others.sort((a, b) => b.time - a.time || b.order - a.order);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const text of [...own.reverse(), ...others.map((o) => o.text)]) {
    const key = text.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

/** Где мы в истории: `-1` — свой черновик, иначе индекс в списке от новой реплики. */
export interface HistoryNav {
  index: number;
  draft: string;
}

export const HISTORY_START: HistoryNav = { index: -1, draft: '' };

/**
 * Шаг по истории. ↑ с черновика запоминает набранное; ↓ на самой новой реплике возвращает черновик. `null` — шагать
 * некуда, клавиша остаётся полю (курсор по строкам).
 */
export function historyStep(nav: HistoryNav, entries: readonly string[], dir: 'up' | 'down', current: string): { nav: HistoryNav; text: string } | null {
  if (dir === 'up') {
    if (nav.index + 1 >= entries.length) return null;
    const draft = nav.index === -1 ? current : nav.draft;
    const index = nav.index + 1;
    return { nav: { index, draft }, text: entries[index] };
  }
  if (nav.index < 0) return null;
  const index = nav.index - 1;
  return { nav: { index, draft: nav.draft }, text: index < 0 ? nav.draft : entries[index] };
}

/** ↑ уходит в историю, только если курсор на первой строке и ничего не выделено, ↓ — на последней. */
export function caretOnFirstLine(text: string, selectionStart: number, selectionEnd: number): boolean {
  return selectionStart === selectionEnd && !text.slice(0, selectionStart).includes('\n');
}

export function caretOnLastLine(text: string, selectionStart: number, selectionEnd: number): boolean {
  return selectionStart === selectionEnd && !text.slice(selectionEnd).includes('\n');
}
