import type { ReactElement } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeHighlight from 'rehype-highlight';
import { CodeBlock } from './CodeBlock';

/**
 * The markdown element map for chat message bodies (and the run log, which
 * uses the same renderer with a mono wrapper).
 *
 * Borders are set inline rather than with Tailwind border utilities: the
 * console scope has a wildcard `border-color: var(--border)` rule that would
 * repaint them (see `theme.css`, mirrored in `MessageItem`/`StreamCard`).
 */
export const MD_COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline decoration-text-tertiary/50 underline-offset-2 transition-colors hover:text-accent-bright hover:decoration-accent-bright"
    >
      {children}
    </a>
  ),
  code: ({ className, children }) => {
    // rehype-highlight rewrites the class to `hljs language-…`, so the old
    // `startsWith('language-')` check missed every highlighted block and gave
    // it inline-code padding. A plain fence carries no language class at all —
    // CodeBlock neutralises the inline styling for whatever sits in its <pre>.
    const isBlock = className !== undefined && /(^|\s)language-/.test(className);
    if (isBlock) {
      return <code className={className}>{children}</code>;
    }
    return (
      <code className="rounded bg-surface-inset px-1 py-[1px] font-mono text-[12px] text-text-primary">
        {children}
      </code>
    );
  },
  h1: ({ children }) => (
    <h1 className="mt-2 mb-1.5 text-[14px] font-semibold text-text-primary">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-2 mb-1 text-[13px] font-semibold text-text-primary">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-1.5 mb-0.5 text-[12px] font-semibold uppercase tracking-wider text-text-secondary">
      {children}
    </h3>
  ),
  p: ({ children }) => <p className="my-1 leading-relaxed">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-1 ml-5 list-disc space-y-0.5 marker:text-text-tertiary">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1 ml-5 list-decimal space-y-0.5 marker:text-text-tertiary">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-border pl-2 text-text-secondary">
      {children}
    </blockquote>
  ),
  // GFM tables had no overrides at all, so they fell back to browser defaults —
  // no separators, columns out of line, the header lost in the middle. The
  // wrapper scrolls instead of widening the chat column, which is narrow.
  table: ({ children }) => (
    <div
      className="my-2 max-w-full overflow-x-auto rounded border"
      style={{ borderColor: 'var(--border)' }}
    >
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead style={{ background: 'color-mix(in oklch, var(--brand-teal), transparent 92%)' }}>
      {children}
    </thead>
  ),
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => (
    <tr style={{ borderTop: '1px solid var(--border)' }} className="[&:first-child]:border-t-0">
      {children}
    </tr>
  ),
  // `style.textAlign` is what remark-gfm turns a column's `:---:` marker into;
  // columns with no marker stay left-aligned.
  th: ({ children, style }) => (
    <th
      className="whitespace-nowrap px-[10px] py-[6px] font-semibold text-text-primary"
      style={{
        textAlign: style?.textAlign ?? 'left',
        borderRight: '1px solid var(--border)',
      }}
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td
      className="px-[10px] py-[6px] align-top text-text-secondary"
      style={{
        textAlign: style?.textAlign ?? 'left',
        borderRight: '1px solid var(--border)',
      }}
    >
      {children}
    </td>
  ),
};

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS = [rehypeHighlight];

interface MessageMarkdownProps {
  content: string;
}

/** Chat/log markdown body: GFM + soft line breaks + syntax highlighting. */
export function MessageMarkdown({ content }: MessageMarkdownProps): ReactElement {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      components={MD_COMPONENTS}
    >
      {content}
    </ReactMarkdown>
  );
}
