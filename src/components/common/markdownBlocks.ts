/**
 * Разбор markdown на верхнеуровневые блоки для MarkdownViewer (чистая функция без React —
 * вынесена из компонента, чтобы покрыть тестами, TASK-49).
 */
export interface MarkdownBlock {
  type: 'heading' | 'code' | 'mermaid' | 'alert' | 'table' | 'list' | 'blockquote' | 'paragraph' | 'hr';
  level?: number;
  lang?: string;
  code?: string;
  alertType?: CalloutType;
  /** Свой заголовок callout'а Obsidian (`> [!tip] Заголовок`); без него показывается название типа. */
  alertTitle?: string;
  alertContent?: string;
  /** Сворачиваемый callout Obsidian: `[!faq]-` — свёрнут, `[!faq]+` — развёрнут. */
  alertFold?: 'open' | 'closed';
  rows?: string[][];
  headers?: string[];
  items?: string[];
  ordered?: boolean;
  raw?: string;
}

/** Типы callout'ов Obsidian (GitHub-alerts — их подмножество: note, tip, important, warning, caution). */
export type CalloutType =
  | 'note'
  | 'abstract'
  | 'info'
  | 'todo'
  | 'tip'
  | 'success'
  | 'question'
  | 'warning'
  | 'failure'
  | 'danger'
  | 'bug'
  | 'example'
  | 'quote'
  | 'important'
  | 'caution';

/** Синонимы типов, как в Obsidian; неизвестный тип показывается как `note` (так делает и Obsidian). */
const CALLOUT_ALIASES: Record<string, CalloutType> = {
  summary: 'abstract',
  tldr: 'abstract',
  hint: 'tip',
  check: 'success',
  done: 'success',
  help: 'question',
  faq: 'question',
  attention: 'warning',
  fail: 'failure',
  missing: 'failure',
  error: 'danger',
  cite: 'quote'
};

const CALLOUT_TYPES = new Set<string>([
  'note', 'abstract', 'info', 'todo', 'tip', 'success', 'question', 'warning',
  'failure', 'danger', 'bug', 'example', 'quote', 'important', 'caution'
]);

export function calloutType(raw: string): CalloutType {
  const key = raw.toLowerCase();
  if (CALLOUT_TYPES.has(key)) return key as CalloutType;
  return CALLOUT_ALIASES[key] ?? 'note';
}

/**
 * Комментарии Obsidian `%%…%%` (TASK-178) не показываются. Внутри блоков кода `%%` — текст, его не трогаем.
 */
export function stripObsidianComments(text: string): string {
  if (!text.includes('%%')) return text;
  return text
    .split(/(```[\s\S]*?(?:```|$))/g)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/%%[\s\S]*?(?:%%|$)/g, '')))
    .join('');
}

export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  // Strip YAML frontmatter if present
  let cleanText = text;
  if (cleanText.startsWith('---')) {
    const endMatch = cleanText.indexOf('\n---', 3);
    if (endMatch !== -1) {
      cleanText = cleanText.substring(endMatch + 4).trim();
    }
  }
  cleanText = stripObsidianComments(cleanText);

  const lines = cleanText.split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  const isHeading = (line: string) => /^(#{1,6})\s+(.*)$/.test(line);
  const isHr = (line: string) => /^(-{3,}|\*{3,}|_{3,})$/.test(line.trim());
  const isCodeBlock = (line: string) => line.trim().startsWith('```');
  const isAlertOrQuote = (line: string) => line.trim().startsWith('>');
  const isList = (line: string) => /^(\*|-|\+|\d+\.)\s+/.test(line.trim());
  const isTable = (line: string, nextLine?: string) => Boolean(
    line.trim().startsWith('|') &&
    line.trim().endsWith('|') &&
    nextLine &&
    nextLine.includes('---')
  );

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // 1. Empty lines
    if (!trimmed) {
      i++;
      continue;
    }

    // 2. Horizontal Rule (---, ***, ___)
    if (isHr(trimmed)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // 3. Fenced Code Block / Mermaid
    if (isCodeBlock(trimmed)) {
      const lang = trimmed.substring(3).trim().toLowerCase();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length && lines[i].trim().startsWith('```')) {
        i++; // skip closing ```
      }

      const codeContent = codeLines.join('\n');
      if (lang === 'mermaid') {
        blocks.push({ type: 'mermaid', code: codeContent });
      } else {
        blocks.push({ type: 'code', lang: lang || 'text', code: codeContent });
      }
      continue;
    }

    // 4. Headings (#, ##, ###, ####)
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        raw: headingMatch[2].trim()
      });
      i++;
      continue;
    }

    // 5. Callout Obsidian и GitHub-alert: `> [!tip]`, `> [!faq]- Свой заголовок` (TASK-178).
    // Текст после маркера — заголовок, как в Obsidian; GitHub такой alert не рисует вовсе.
    const alertMatch = trimmed.match(/^>\s*\[!([a-z][\w-]*)\]([+-]?)\s*(.*)$/i);
    if (alertMatch) {
      const alertLines: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        alertLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }

      const block: MarkdownBlock = {
        type: 'alert',
        alertType: calloutType(alertMatch[1]),
        alertContent: alertLines.join('\n').trim()
      };
      const title = alertMatch[3].trim();
      if (title) block.alertTitle = title;
      if (alertMatch[2]) block.alertFold = alertMatch[2] === '-' ? 'closed' : 'open';
      blocks.push(block);
      continue;
    }

    // 6. Blockquote
    if (isAlertOrQuote(trimmed)) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({
        type: 'blockquote',
        raw: quoteLines.join('\n').trim()
      });
      continue;
    }

    // 7. Markdown Table (| col 1 | col 2 |)
    if (isTable(trimmed, lines[i + 1])) {
      const headers = trimmed.split('|').slice(1, -1).map((s) => s.trim());
      i += 2; // skip header and delimiter row
      const rows: string[][] = [];

      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        const rowCells = lines[i].trim().split('|').slice(1, -1).map((s) => s.trim());
        rows.push(rowCells);
        i++;
      }

      blocks.push({
        type: 'table',
        headers,
        rows
      });
      continue;
    }

    // 8. Lists (Unordered - or *, Ordered 1.)
    if (isList(trimmed)) {
      const items: string[] = [];
      const isOrdered = /^\d+\./.test(trimmed);

      while (i < lines.length && isList(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^(\*|-|\+|\d+\.)\s+/, ''));
        i++;
      }

      blocks.push({
        type: 'list',
        items,
        ordered: isOrdered
      });
      continue;
    }

    // 9. Standard Paragraph (always consumes at least current line, then continues until next block)
    const paragraphLines: string[] = [lines[i]];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isHeading(lines[i]) &&
      !isCodeBlock(lines[i]) &&
      !isAlertOrQuote(lines[i]) &&
      !isHr(lines[i]) &&
      !isList(lines[i]) &&
      !isTable(lines[i], lines[i + 1])
    ) {
      paragraphLines.push(lines[i]);
      i++;
    }

    blocks.push({
      type: 'paragraph',
      raw: paragraphLines.join('\n')
    });
  }

  return blocks;
}
