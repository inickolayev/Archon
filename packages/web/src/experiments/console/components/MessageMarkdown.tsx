import { Children, isValidElement, useMemo, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeHighlight from 'rehype-highlight';
import { CodeBlock } from './CodeBlock';
import {
  chatImageUrl,
  imageName,
  isLocalImagePath,
  withInlineImages,
} from '../primitives/chat-image';

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

/**
 * The `img` element map for a message that belongs to a conversation: a local
 * path becomes a thumbnail the reader can open full screen, and anything else
 * (a remote image the agent linked) renders as the plain image it already was.
 *
 * The bytes come from the conversation's own image route, which re-decides
 * whether that path may be shown at all — a path here is a request, not a
 * permission. A path the server refuses simply fails to load, exactly as a
 * broken link does, and the surrounding text still says where the file is.
 */
function imageComponents(conversationId: string, onOpen: (path: string) => void): Components {
  /**
   * Held in a named binding so the paragraph below can recognise its own
   * thumbnails among a paragraph's children — comparing against the element
   * type is the only way to tell a picture from a word once react-markdown has
   * rendered it. (Lowercase to satisfy the repo's naming rule; it is never used
   * as a JSX tag, only as the `img` mapping and as that identity.)
   */
  const thumbnail = ({ src, alt }: { src?: string; alt?: string }): ReactElement => {
    const path = typeof src === 'string' ? src : undefined;
    if (!isLocalImagePath(path)) return <img src={path} alt={alt ?? ''} />;
    const label = alt !== undefined && alt.length > 0 ? alt : imageName(path);
    return (
      <button
        type="button"
        onClick={() => {
          onOpen(path);
        }}
        title={path}
        aria-label={`Open ${label} full screen`}
        className="my-[6px] inline-block max-w-full overflow-hidden rounded-[8px] border align-top transition-opacity hover:opacity-85"
        style={{ borderColor: 'var(--border-bright)' }}
      >
        <img
          src={chatImageUrl(conversationId, path)}
          alt={label}
          className="block max-h-[320px] max-w-full object-contain"
        />
      </button>
    );
  };

  const isThumbnail = (node: ReactNode): boolean => isValidElement(node) && node.type === thumbnail;

  return {
    ...MD_COMPONENTS,
    img: thumbnail,
    /**
     * A paragraph of several pictures is laid out as a grid rather than a
     * column. Screenshots are tall and narrow, so one per line wastes most of
     * the width; side by side, four of them fit where one used to be. Any prose
     * that shares the paragraph keeps its place on a line of its own
     * (`basis-full`), so nothing is reordered — only rewrapped.
     */
    p: ({ children }): ReactElement => {
      const nodes = Children.toArray(children);
      if (nodes.filter(isThumbnail).length < 2) return <p>{children}</p>;
      return (
        <div className="flex flex-wrap items-start gap-[6px]">
          {nodes
            .filter(node => !(isValidElement(node) && node.type === 'br'))
            .map((node, index) =>
              isThumbnail(node) ? (
                node
              ) : (
                <span key={index} className="basis-full">
                  {node}
                </span>
              )
            )}
        </div>
      );
    },
  };
}

interface MessageMarkdownProps {
  content: string;
  /**
   * The conversation this message belongs to. Given, the paths the message
   * names are drawn as pictures; omitted (the run log, where the artifact panel
   * already shows the files), they stay as the text the agent wrote.
   */
  conversationId?: string;
  onOpenImage?: (path: string) => void;
}

/** Chat/log markdown body: GFM + soft line breaks + syntax highlighting. */
export function MessageMarkdown({
  content,
  conversationId,
  onOpenImage,
}: MessageMarkdownProps): ReactElement {
  const inline = conversationId !== undefined && onOpenImage !== undefined;
  const body = useMemo(() => (inline ? withInlineImages(content) : content), [inline, content]);
  const components = useMemo(
    () =>
      conversationId !== undefined && onOpenImage !== undefined
        ? imageComponents(conversationId, onOpenImage)
        : MD_COMPONENTS,
    [conversationId, onOpenImage]
  );

  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      components={components}
    >
      {body}
    </ReactMarkdown>
  );
}
