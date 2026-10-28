import React, { createContext, useContext } from 'react';
import { MermaidDiagram } from './MermaidDiagram';
import { parseMarkdownBlocks, type CalloutType, type MarkdownBlock } from './markdownBlocks';
import {
  Copy,
  Check,
  Info,
  AlertTriangle,
  AlertCircle,
  Lightbulb,
  Flame,
  FileText,
  ListTodo,
  CheckCircle2,
  HelpCircle,
  XCircle,
  Zap,
  List,
  Quote,
  ChevronRight,
  Layers
} from './icons';
import { useI18n } from '../../i18n';
import { useTimeoutState } from '../../hooks/useTimeoutState';
import { useDocRefs, type DocRefNavigation } from '../../hooks/useDocRefs';
import { tokenizeDocRefs, docRefFromHref, headingAnchorKey, type DocRef } from '../../utils/docRefs';

/** Перекрёстные ссылки Backlog.md для вложенных блоков: хук стора вызывается один раз на документ. */
const DocRefContext = createContext<DocRefNavigation | null>(null);

interface MarkdownViewerProps {
  content: string;
  className?: string;
  emptyMessage?: string | null;
  /** Ссылки `[[id]]` не локального проекта, например проекта удалённого ПК (TASK-229); по умолчанию — свой проект. */
  refs?: DocRefNavigation;
}

export const MarkdownViewer: React.FC<MarkdownViewerProps> = ({
  content,
  className = '',
  emptyMessage,
  refs
}) => {
  const { t } = useI18n();
  const localRefs = useDocRefs();
  const docRefs = refs ?? localRefs;
  const effectiveEmptyMessage = emptyMessage !== undefined ? emptyMessage : t.markdown.emptyDocument;

  if (!content || !content.trim()) {
    if (effectiveEmptyMessage === null) return null;
    return <div className="text-xs text-slate-500 italic p-4">{effectiveEmptyMessage}</div>;
  }

  // Parse markdown into high-level blocks
  const blocks = parseMarkdownBlocks(content);

  return (
    <DocRefContext.Provider value={docRefs}>
      <div className={`space-y-3.5 text-xs text-slate-200 leading-relaxed font-sans select-text ${className}`}>
        {blocks.map((block, idx) => (
          <BlockRenderer key={idx} block={block} />
        ))}
      </div>
    </DocRefContext.Provider>
  );
};

const BlockRenderer: React.FC<{ block: MarkdownBlock }> = ({ block }) => {
  switch (block.type) {
    case 'hr':
      return <hr className="my-6 border-slate-800" />;

    case 'heading': {
      const text = block.raw || '';
      // Ключ заголовка — цель ссылки `[[id#Заголовок]]` (decision-69).
      const headingKey = headingAnchorKey(text) || undefined;
      if (block.level === 1) {
        return (
          <h1 data-heading-key={headingKey} className="text-xl font-bold text-white tracking-tight pb-2 border-b border-slate-800 mt-6 mb-4 flex items-center gap-2">
            <span className="w-1.5 h-5 rounded-full bg-indigo-500" />
            <InlineMarkdown text={text} />
          </h1>
        );
      }
      if (block.level === 2) {
        return (
          <h2 data-heading-key={headingKey} className="text-base font-semibold text-slate-100 mt-6 mb-3 pb-1 border-b border-slate-800/60 flex items-center gap-2">
            <span className="w-1 h-3.5 rounded-full bg-cyan-500" />
            <InlineMarkdown text={text} />
          </h2>
        );
      }
      if (block.level === 3) {
        return (
          <h3 data-heading-key={headingKey} className="text-sm font-semibold text-indigo-300 mt-4 mb-2">
            <InlineMarkdown text={text} />
          </h3>
        );
      }
      return (
        <h4 data-heading-key={headingKey} className="text-xs font-medium text-slate-200 mt-3 mb-1 text-slate-400">
          <InlineMarkdown text={text} />
        </h4>
      );
    }

    case 'mermaid':
      return <MermaidDiagram chart={block.code || ''} />;

    case 'code':
      return <CodeBlock lang={block.lang || 'text'} code={block.code || ''} />;

    case 'alert':
      return (
        <AlertBlock type={block.alertType || 'note'} title={block.alertTitle} fold={block.alertFold} content={block.alertContent || ''} />
      );

    case 'table':
      return <TableBlock headers={block.headers || []} rows={block.rows || []} />;

    case 'list':
      return (
        <ul className={`space-y-1.5 my-3 pl-4 ${block.ordered ? 'list-decimal' : 'list-disc'} marker:text-indigo-400`}>
          {(block.items || []).map((item, idx) => {
            const isTask = item.startsWith('[ ]') || item.startsWith('[x]') || item.startsWith('[X]');
            if (isTask) {
              const isChecked = !item.startsWith('[ ]');
              const taskText = item.replace(/^\[[ xX]\]\s*/, '');
              return (
                <li key={idx} className="list-none -ml-4 flex items-start gap-2 text-slate-300">
                  <input
                    type="checkbox"
                    checked={isChecked}
                    readOnly
                    className="mt-0.5 rounded bg-slate-900 border-slate-700 text-indigo-600 focus:ring-0 focus:ring-offset-0 cursor-default"
                  />
                  <span className={isChecked ? 'line-through text-slate-500' : ''}>
                    <InlineMarkdown text={taskText} />
                  </span>
                </li>
              );
            }
            return (
              <li key={idx} className="text-slate-300">
                <InlineMarkdown text={item} />
              </li>
            );
          })}
        </ul>
      );

    case 'blockquote':
      return (
        <blockquote className="my-3 pl-4 border-l-2 border-indigo-500/60 bg-indigo-950/10 py-2 pr-3 rounded-r-lg text-slate-300 italic">
          <InlineMarkdown text={block.raw || ''} />
        </blockquote>
      );

    case 'paragraph':
      return (
        <p className="my-2.5 text-slate-300 leading-relaxed">
          <InlineMarkdown text={block.raw || ''} />
        </p>
      );

    default:
      return null;
  }
};

const CodeBlock: React.FC<{ lang: string; code: string }> = ({ lang, code }) => {
  const { t } = useI18n();
  // Индикатор «скопировано» гаснет сам; таймер снимается при размонтировании (TASK-50)
  const [copied, showCopied] = useTimeoutState(false, 2000);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    showCopied(true);
  };

  return (
    <div className="my-4 rounded-xl border border-slate-800 bg-ph-panel overflow-hidden shadow-lg group">
      <div className="px-4 py-1.5 border-b border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400 font-mono">
        <span className="uppercase text-indigo-400 font-semibold">{lang}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 hover:text-white transition px-2 py-0.5 rounded hover:bg-slate-700/50"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? t.markdown.copied : t.markdown.copy}
        </button>
      </div>
      <pre className="p-4 overflow-x-auto text-[11px] font-mono text-slate-200 leading-relaxed selection:bg-indigo-500/30">
        <code>{code}</code>
      </pre>
    </div>
  );
};

type CalloutStyle = { icon: React.ComponentType<{ className?: string }>; border: string; bg: string; text: string };

const BLUE: Omit<CalloutStyle, 'icon'> = { border: 'border-blue-500/40', bg: 'bg-blue-950/20', text: 'text-blue-400' };
const CYAN: Omit<CalloutStyle, 'icon'> = { border: 'border-cyan-500/40', bg: 'bg-cyan-950/20', text: 'text-cyan-400' };
const GREEN: Omit<CalloutStyle, 'icon'> = { border: 'border-emerald-500/40', bg: 'bg-emerald-950/20', text: 'text-emerald-400' };
const AMBER: Omit<CalloutStyle, 'icon'> = { border: 'border-amber-500/40', bg: 'bg-amber-950/20', text: 'text-amber-400' };
const RED: Omit<CalloutStyle, 'icon'> = { border: 'border-red-500/40', bg: 'bg-red-950/20', text: 'text-red-400' };

/** Цвета и значки callout'ов в духе Obsidian (TASK-178): те же группы цветов, палитра приложения. */
const CALLOUT_STYLES: Record<CalloutType, CalloutStyle> = {
  note: { icon: Info, ...BLUE },
  abstract: { icon: FileText, ...CYAN },
  info: { icon: Info, ...BLUE },
  todo: { icon: ListTodo, ...BLUE },
  tip: { icon: Lightbulb, ...CYAN },
  success: { icon: CheckCircle2, ...GREEN },
  question: { icon: HelpCircle, ...AMBER },
  warning: { icon: AlertTriangle, ...AMBER },
  failure: { icon: XCircle, ...RED },
  danger: { icon: Zap, ...RED },
  bug: { icon: AlertCircle, ...RED },
  example: { icon: List, border: 'border-violet-500/40', bg: 'bg-violet-950/20', text: 'text-violet-400' },
  quote: { icon: Quote, border: 'border-slate-500/40', bg: 'bg-slate-800/30', text: 'text-slate-400' },
  important: { icon: Flame, border: 'border-indigo-500/40', bg: 'bg-indigo-950/20', text: 'text-indigo-400' },
  caution: { icon: AlertCircle, ...RED }
};

/**
 * Callout Obsidian и GitHub-alert. Содержимое — обычный Markdown (списки, код, вложенные callout'ы), поэтому
 * разбирается на блоки заново; сворачиваемый callout (`[!faq]-`) рисуется через `<details>`.
 */
const AlertBlock: React.FC<{ type: CalloutType; title?: string; fold?: 'open' | 'closed'; content: string }> = ({
  type,
  title,
  fold,
  content
}) => {
  const { t } = useI18n();
  const config = CALLOUT_STYLES[type] ?? CALLOUT_STYLES.note;
  const IconComp = config.icon;
  const heading = (
    <span className={`flex items-center gap-2 text-[11px] font-medium ${config.text}`}>
      <IconComp className="w-4 h-4 shrink-0" />
      <InlineMarkdown text={title || t.markdown.callouts[type]} />
      {fold && <ChevronRight className="w-3.5 h-3.5 shrink-0 transition-transform group-open:rotate-90" />}
    </span>
  );
  const body = content ? (
    <div className="mt-2 pl-6 space-y-2 text-xs text-slate-300 leading-relaxed">
      {parseMarkdownBlocks(content).map((block, idx) => (
        <BlockRenderer key={idx} block={block} />
      ))}
    </div>
  ) : null;
  const frame = `my-4 p-4 rounded-xl border ${config.border} ${config.bg} shadow-md`;

  if (fold) {
    return (
      <details className={`${frame} group`} open={fold === 'open'} data-callout={type}>
        <summary className="list-none cursor-pointer select-none [&::-webkit-details-marker]:hidden">{heading}</summary>
        {body}
      </details>
    );
  }
  return (
    <div className={frame} data-callout={type}>
      {heading}
      {body}
    </div>
  );
};

const TableBlock: React.FC<{ headers: string[]; rows: string[][] }> = ({ headers, rows }) => {
  return (
    <div className="my-4 overflow-x-auto rounded-xl border border-slate-800 shadow-md">
      <table className="w-full text-left border-collapse text-xs">
        {headers.length > 0 && (
          <thead>
            <tr className="bg-ph-raised border-b border-slate-800 text-slate-200">
              {headers.map((h, idx) => (
                <th key={idx} className="px-4 py-2.5 font-semibold">
                  <InlineMarkdown text={h} />
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody className="divide-y divide-slate-800/60 bg-ph-elevated">
          {rows.map((row, rIdx) => (
            <tr key={rIdx} className="hover:bg-slate-800/30 transition">
              {row.map((cell, cIdx) => (
                <td key={cIdx} className="px-4 py-2.5 text-slate-300 align-middle">
                  <InlineMarkdown text={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const InlineMarkdown: React.FC<{ text: string }> = ({ text }) => {
  const docRefs = useContext(DocRefContext);
  if (!text) return null;

  // Split by markdown images: ![alt](url) OR html img tags: <img src="..." />
  const imageRegex = /(!\[([^\]]*)\]\(([^)]+)\)|<img\s+([^>]+?)\/?>)/gi;
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let match;

  while ((match = imageRegex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(renderFormattedText(text.substring(lastIdx, match.index), parts.length, docRefs));
    }

    if (match[0].startsWith('![')) {
      // Markdown style: ![alt](url)
      const alt = match[2] || '';
      const src = match[3] || '';
      parts.push(
        <img
          key={`md-img-${match.index}`}
          src={src}
          alt={alt}
          className="inline-block max-w-full rounded-xl border border-slate-800 shadow-lg my-1.5 object-contain"
          style={{ maxHeight: '360px' }}
        />
      );
    } else {
      // HTML style: <img src="..." ... />
      const attrString = match[4] || '';
      const srcMatch = attrString.match(/src=["']([^"']+)["']/i);
      const altMatch = attrString.match(/alt=["']([^"']+)["']/i);
      const widthMatch = attrString.match(/width=["']?(\d+)(?:px)?["']?/i);
      const heightMatch = attrString.match(/height=["']?(\d+)(?:px)?["']?/i);

      const src = srcMatch ? srcMatch[1] : '';
      const alt = altMatch ? altMatch[1] : 'Image';
      const width = widthMatch ? parseInt(widthMatch[1], 10) : undefined;
      const height = heightMatch ? parseInt(heightMatch[1], 10) : undefined;

      parts.push(
        <img
          key={`html-img-${match.index}`}
          src={src}
          alt={alt}
          width={width}
          height={height}
          className="inline-block max-w-full rounded-lg border border-slate-800/80 shadow-md my-1 object-contain"
          style={{
            width: width ? `${width}px` : undefined,
            height: height ? `${height}px` : undefined,
            maxHeight: '360px'
          }}
        />
      );
    }

    lastIdx = match.index + match[0].length;
  }

  if (lastIdx < text.length) {
    parts.push(renderFormattedText(text.substring(lastIdx), parts.length, docRefs));
  }

  return <>{parts}</>;
};

/**
 * Ссылка из markdown: никакого target="_blank" (открывало бы внешний сайт в окне Electron с preload
 * и доступом к window.api). http/https/mailto уходят в системный браузер через window.api.openExternal,
 * остальные схемы и относительные пути не открываются вовсе (TASK-30).
 */
const ExternalLink: React.FC<{ href: string; children: React.ReactNode }> = ({ href, children }) => {
  const isOpenable = /^(https?:|mailto:)/i.test(href.trim());
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (isOpenable) {
      void window.api.openExternal(href.trim());
    }
  };
  return (
    <a
      href={href}
      onClick={handleClick}
      title={isOpenable ? href : undefined}
      className={`underline underline-offset-2 ${
        isOpenable
          ? 'text-cyan-400 hover:text-cyan-300 decoration-cyan-500/40 cursor-pointer'
          : 'text-slate-400 decoration-slate-600 cursor-default'
      }`}
    >
      {children}
    </a>
  );
};

/**
 * Перекрёстная ссылка Backlog.md (TASK-121, decision-68). `[[id]]` показывается ссылкой всегда:
 * существующий объект открывается по клику, несуществующий помечен и не кликается. Упоминание
 * идентификатора без скобок становится ссылкой, только если объект существует.
 */
const DocRefLink: React.FC<{ docRef: DocRef; nav: DocRefNavigation | null; children?: React.ReactNode }> = ({
  docRef,
  nav,
  children
}) => {
  const { t } = useI18n();
  const resolved = nav?.resolve(docRef) ?? null;
  const label = docRef.embed ? (
    <span className="inline-flex items-center gap-1 align-baseline">
      <Layers className="w-3 h-3 shrink-0 opacity-70" />
      {children ?? docRef.label}
    </span>
  ) : (
    children ?? docRef.label
  );

  if (!nav || !resolved) {
    if (!docRef.wiki) return <>{label}</>;
    return (
      <span
        title={t.markdown.refNotFound.replace('{id}', docRef.id)}
        data-doc-ref={docRef.id}
        data-doc-ref-missing="true"
        className="text-slate-500 underline decoration-dotted decoration-rose-500/60 underline-offset-2 cursor-help"
      >
        {label}
      </span>
    );
  }

  const title = [
    docRef.embed ? `${t.markdown.refEmbed}.` : '',
    resolved.title !== docRef.id ? resolved.title : '',
    resolved.status ? `[${resolved.status}]` : '',
    resolved.anchorMissing
      ? `— ${t.markdown.refAnchorNotFound.replace('{id}', docRef.id).replace('{anchor}', docRef.anchor ?? '')}`
      : ''
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <a
      href={`#${docRef.id}`}
      data-doc-ref={docRef.id}
      data-doc-ref-anchor={docRef.anchor}
      data-doc-ref-anchor-missing={resolved.anchorMissing ? 'true' : undefined}
      title={title || undefined}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        nav.open(docRef);
      }}
      className={
        resolved.anchorMissing
          ? 'text-indigo-300 hover:text-indigo-200 underline decoration-dotted decoration-amber-500/70 underline-offset-2 cursor-pointer'
          : docRef.wiki
          ? 'text-indigo-300 hover:text-indigo-200 underline decoration-indigo-500/50 underline-offset-2 cursor-pointer'
          : 'text-slate-200 hover:text-indigo-200 underline decoration-dotted decoration-slate-500 underline-offset-2 cursor-pointer'
      }
    >
      {label}
    </a>
  );
};

/**
 * Вики-ссылка Obsidian на заметку без идентификатора Backlog.md (`[[Идеи]]`, `![[схема.png]]`): открыть её
 * в ProjectHub нечем, поэтому показываем подпись без скобок, приглушённо, с объяснением в подсказке.
 */
const WikiPlain: React.FC<{ raw: string }> = ({ raw }) => {
  const { t } = useI18n();
  const inner = raw.replace(/^!?\[\[|\]\]$/g, '');
  const [target, alias] = inner.split('|');
  const name = target.split('#')[0].trim();
  return (
    <span title={t.markdown.wikiNotBacklog.replace('{name}', name)} className="text-slate-400 underline decoration-dotted decoration-slate-600 underline-offset-2 cursor-help">
      {(alias ?? target).trim()}
    </span>
  );
};

function renderTextWithRefs(text: string, keyPrefix: string, nav: DocRefNavigation | null): React.ReactNode {
  const tokens = tokenizeDocRefs(text);
  if (tokens.length === 1 && tokens[0].type === 'text') {
    return /^!?\[\[[^\]\n]+\]\]$/.test(text) ? <WikiPlain raw={text} /> : text;
  }
  return tokens.map((token, idx) =>
    token.type === 'text' ? token.value : <DocRefLink key={`${keyPrefix}-${idx}`} docRef={token} nav={nav} />
  );
}

function renderFormattedText(str: string, keyPrefix: number, nav: DocRefNavigation | null): React.ReactNode {
  // Replace bold, italic, inline code, links. `[[id]]`, `[[id|подпись]]` и встраивание `![[id]]` выделяются
  // отдельным токеном, чтобы подпись ссылки не разбиралась как разметка; `==текст==` — выделение Obsidian.
  const tokens = str.split(/(`[^`]+`|!?\[\[[^\]\n]+\]\]|==[^=\s](?:[^=\n]*[^=\s])?==|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g);

  return (
    <span key={`ftext-${keyPrefix}`}>
      {tokens.map((token, idx) => {
        if (token.startsWith('`') && token.endsWith('`')) {
          return (
            <code key={idx} className="px-1.5 py-0.5 rounded bg-slate-800/80 text-indigo-300 font-mono text-[11px] border border-slate-700/40">
              {token.slice(1, -1)}
            </code>
          );
        }
        if (/^==[^=\s](?:[^=\n]*[^=\s])?==$/.test(token)) {
          return (
            <mark key={idx} className="px-0.5 rounded bg-amber-400/25 text-amber-100">
              {renderTextWithRefs(token.slice(2, -2), `h${idx}`, nav)}
            </mark>
          );
        }
        if (token.startsWith('**') && token.endsWith('**')) {
          return (
            <strong key={idx} className="font-semibold text-white">
              {renderTextWithRefs(token.slice(2, -2), `b${idx}`, nav)}
            </strong>
          );
        }
        if (token.startsWith('*') && token.endsWith('*')) {
          return (
            <em key={idx} className="italic text-slate-300">
              {renderTextWithRefs(token.slice(1, -1), `i${idx}`, nav)}
            </em>
          );
        }
        const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (linkMatch) {
          // Относительная ссылка на файл Backlog.md (`decision-46 - Заголовок.md`) открывает документ.
          const fileRef = docRefFromHref(linkMatch[2]);
          if (fileRef) {
            return (
              <DocRefLink key={idx} docRef={fileRef} nav={nav}>
                {linkMatch[1]}
              </DocRefLink>
            );
          }
          return (
            <ExternalLink key={idx} href={linkMatch[2]}>
              {linkMatch[1]}
            </ExternalLink>
          );
        }
        return <React.Fragment key={idx}>{renderTextWithRefs(token, `t${idx}`, nav)}</React.Fragment>;
      })}
    </span>
  );
}
