import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { parseMarkdownBlocks, type MarkdownBlock } from '../../../src/components/common/markdownBlocks';
import { copyText } from '../platform/clipboard';
import { parseInline, type InlineToken } from './markdownInline';

/**
 * Ответ агента на телефоне в Markdown (TASK-140.10): заголовки, списки, цитаты, таблицы, ссылки, блоки кода
 * с кнопкой копирования. Блоки разбирает тот же `parseMarkdownBlocks`, что и MarkdownViewer на ПК; рендер —
 * свой, без сторов ПК. HTML из ответа не исполняется: всё идёт текстом через React.
 */

function Inline({ tokens }: { tokens: InlineToken[] }) {
  return (
    <>
      {tokens.map((t, i) => {
        switch (t.type) {
          case 'code':
            return (
              <code key={i} className="rounded bg-black/30 px-1 py-0.5 font-mono text-[12.5px] text-amber-200">
                {t.text}
              </code>
            );
          case 'bold':
            return (
              <strong key={i} className="font-semibold">
                <Inline tokens={t.children} />
              </strong>
            );
          case 'italic':
            return (
              <em key={i}>
                <Inline tokens={t.children} />
              </em>
            );
          case 'link':
            return (
              <a key={i} href={t.href} target="_blank" rel="noopener noreferrer" className="break-all text-indigo-300 underline">
                {t.text}
              </a>
            );
          default:
            return <span key={i}>{t.text}</span>;
        }
      })}
    </>
  );
}

function InlineText({ text }: { text: string }) {
  const tokens = useMemo(() => parseInline(text), [text]);
  return <Inline tokens={tokens} />;
}

/** Блок кода: язык, кнопка «Копировать» и прокрутка по горизонтали — строки не переносятся. */
export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="my-2 overflow-hidden rounded-xl border border-ph-line bg-black/40">
      <div className="flex items-center justify-between border-b border-ph-line px-3 py-1">
        <span className="font-mono text-[11px] uppercase tracking-wide text-slate-500">{lang && lang !== 'text' ? lang : 'код'}</span>
        <button
          type="button"
          onClick={async () => setCopied(await copyText(code))}
          className="-mr-2 flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-slate-300 active:bg-ph-hover"
          aria-label="Копировать код"
        >
          {copied ? <CheckIcon size={15} className="text-emerald-400" /> : <CopyIcon size={15} />}
          {copied ? 'Скопировано' : 'Копировать'}
        </button>
      </div>
      <pre className="selectable overflow-x-auto px-3 py-2 font-mono text-[12.5px] leading-relaxed text-slate-100">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const ALERT_TONE: Record<string, string> = {
  note: 'border-sky-500/60 bg-sky-950/40',
  tip: 'border-emerald-500/60 bg-emerald-950/40',
  important: 'border-indigo-500/60 bg-indigo-950/40',
  warning: 'border-amber-500/60 bg-amber-950/40',
  caution: 'border-red-500/60 bg-red-950/40'
};

function Block({ b }: { b: MarkdownBlock }): ReactNode {
  switch (b.type) {
    case 'heading': {
      const size = (b.level ?? 1) <= 1 ? 'text-[18px]' : b.level === 2 ? 'text-[16.5px]' : 'text-[15px]';
      return (
        <div className={clsx('mb-1 mt-3 font-semibold first:mt-0', size)}>
          <InlineText text={b.raw ?? ''} />
        </div>
      );
    }
    case 'code':
    case 'mermaid':
      return <CodeBlock code={b.code ?? ''} lang={b.type === 'mermaid' ? 'mermaid' : b.lang} />;
    case 'hr':
      return <hr className="my-3 border-ph-line" />;
    case 'list': {
      const Tag = b.ordered ? 'ol' : 'ul';
      return (
        <Tag className={clsx('my-1.5 space-y-0.5 pl-5', b.ordered ? 'list-decimal' : 'list-disc')}>
          {(b.items ?? []).map((item, i) => (
            <li key={i}>
              <InlineText text={item} />
            </li>
          ))}
        </Tag>
      );
    }
    case 'blockquote':
      return (
        <blockquote className="my-2 border-l-2 border-slate-500 pl-3 text-slate-300">
          <InlineText text={b.raw ?? ''} />
        </blockquote>
      );
    case 'alert':
      return (
        <div className={clsx('my-2 rounded-lg border-l-2 px-3 py-2', ALERT_TONE[b.alertType ?? 'note'])}>
          <div className="mb-0.5 text-[11px] font-semibold tracking-wide text-slate-300">{b.alertTitle}</div>
          <InlineText text={b.alertContent ?? ''} />
        </div>
      );
    case 'table':
      return (
        <div className="my-2 overflow-x-auto rounded-lg border border-ph-line">
          <table className="min-w-full text-[12.5px]">
            <thead className="bg-black/30">
              <tr>
                {(b.headers ?? []).map((h, i) => (
                  <th key={i} className="whitespace-nowrap px-2 py-1.5 text-left font-semibold">
                    <InlineText text={h} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(b.rows ?? []).map((row, r) => (
                <tr key={r} className="border-t border-ph-line">
                  {row.map((cell, c) => (
                    <td key={c} className="px-2 py-1.5 align-top">
                      <InlineText text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return (
        <p className="my-1 whitespace-pre-wrap first:mt-0 last:mb-0">
          <InlineText text={b.raw ?? ''} />
        </p>
      );
  }
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);
  return (
    <div className="selectable break-words">
      {blocks.map((b, i) => (
        <Block key={i} b={b} />
      ))}
    </div>
  );
}
