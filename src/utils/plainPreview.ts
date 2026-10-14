/**
 * Короткое превью Markdown-текста одной строкой (decision-73): в карточках показывался сырой текст
 * вида «## Description ProjectHub …». Убирает строки-заголовки, маркеры списков и цитат,
 * выделение, код и ссылки (оставляя текст ссылки), схлопывает пробелы.
 */
export const plainPreview = (markdown: string | undefined | null): string => {
  if (!markdown) return '';
  return markdown
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .split(/\r?\n/)
    .filter((line) => !/^\s*#{1,6}\s/.test(line))
    .map((line) => line.replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s?)/, ''))
    .join(' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
};
