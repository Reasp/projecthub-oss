/**
 * Разбор строки Markdown для ответов агента на телефоне (TASK-140.10): `код`, **жирный**, *курсив*,
 * [ссылка](url) и голые http(s)-адреса. Чистая функция без React.
 *
 * Без lookbehind в регулярных выражениях: Safari до 16.4 падает на них при разборе всего бандла.
 * `_курсив_` не поддерживается намеренно — он ломал бы идентификаторы вида `snake_case_name`.
 */

export type InlineToken =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'bold'; children: InlineToken[] }
  | { type: 'italic'; children: InlineToken[] }
  | { type: 'link'; text: string; href: string }
  /** Ссылка Backlog.md `[[decision-46]]`, `[[doc-5|подпись]]`, `[[decision-46#Decision]]` (TASK-140.17); `raw` — как в тексте. */
  | { type: 'docref'; id: string; anchor?: string; label: string; raw: string };

// Жирный может содержать целый *курсив* (`**проверь *всё***`); в адресе ссылки — скобки одного уровня.
// Последняя альтернатива — ссылка `[[id#якорь|подпись]]` (decision-68, decision-69).
const INLINE_RE =
  /(`+)([\s\S]*?)\1|\*\*((?:[^*]|\*[^*\s](?:[^*]*[^*\s])?\*)+?)\*\*|\*([^*\s](?:[^*]*[^*\s])?)\*|\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|\[\[\s*((?:decision|doc|task|mem)-\d+(?:\.\d+)*)\s*(?:#([^\]|\n]*))?(?:\|([^\]\n]*))?\]\]/gi;

/** Ссылка, которую можно открыть: только http(s) и mailto. `javascript:` и прочее — просто текст. */
export function safeHref(href: string): string | null {
  const value = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(value) ? value : null;
}

export function parseInline(text: string, depth = 0): InlineToken[] {
  const out: InlineToken[] = [];
  const pushText = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.type === 'text') last.text += t;
    else out.push({ type: 'text', text: t });
  };
  let pos = 0;
  INLINE_RE.lastIndex = 0;
  const re = new RegExp(INLINE_RE.source, INLINE_RE.flags);
  for (let m = re.exec(text); m; m = re.exec(text)) {
    pushText(text.slice(pos, m.index));
    pos = m.index + m[0].length;
    if (m[1] !== undefined) {
      out.push({ type: 'code', text: m[2].replace(/^ (.*) $/, '$1') });
    } else if (m[3] !== undefined) {
      out.push(depth < 3 ? { type: 'bold', children: parseInline(m[3], depth + 1) } : { type: 'text', text: m[3] });
    } else if (m[4] !== undefined) {
      out.push(depth < 3 ? { type: 'italic', children: parseInline(m[4], depth + 1) } : { type: 'text', text: m[4] });
    } else if (m[5] !== undefined) {
      const href = safeHref(m[6]);
      if (href) out.push({ type: 'link', text: m[5], href });
      else pushText(m[5]);
    } else if (m[7] !== undefined) {
      out.push({ type: 'link', text: m[7], href: m[7] });
    } else if (m[8] !== undefined) {
      const anchor = m[9]?.trim();
      const alias = m[10]?.trim();
      out.push({
        type: 'docref',
        id: m[8].toLowerCase(),
        ...(anchor ? { anchor } : {}),
        label: alias || (anchor ? `${m[8]}#${anchor}` : m[8]),
        raw: m[0]
      });
    }
  }
  pushText(text.slice(pos));
  return out;
}
