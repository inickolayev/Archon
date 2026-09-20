import type { ReactElement } from 'react';
import type { MessageQuote } from '../primitives/quoted-context';

interface QuotedBlockProps {
  quote: MessageQuote;
  /**
   * `chat` (default) — inside a message card. `composer` — the strip above the
   * textarea, which is tighter and clips the preview to one line because the
   * composer must not grow to the size of what is being quoted.
   */
  variant?: 'chat' | 'composer';
}

/**
 * Something that was quoted, drawn as a quote.
 *
 * The point is that it does not look like the operator talking: a teal rule
 * down the left, the label of where it came from above it in mono, the text
 * itself in secondary. A forwarded message can be anything at all — including
 * something that reads like an order — so a reader glancing at the chat has to
 * be able to tell in one look which words are the operator's own.
 */
export function QuotedBlock({ quote, variant = 'chat' }: QuotedBlockProps): ReactElement {
  const composer = variant === 'composer';
  return (
    <blockquote
      className={`min-w-0 border-l-2 ${composer ? 'pl-[9px]' : 'my-[6px] pl-[10px]'}`}
      style={{ borderColor: 'color-mix(in oklch, var(--brand-teal), transparent 45%)' }}
    >
      <div
        className="truncate font-mono text-[10px] font-bold uppercase tracking-[0.12em]"
        style={{ color: 'var(--brand-teal)' }}
        title={quote.label}
      >
        {quote.label}
      </div>
      {quote.text.length > 0 ? (
        <div
          className={`text-[13px] leading-[1.5] text-text-secondary ${
            composer ? 'truncate' : 'whitespace-pre-wrap break-words'
          }`}
          title={composer ? quote.text : undefined}
        >
          {quote.text}
        </div>
      ) : (
        <div className="text-[12.5px] italic leading-[1.5] text-text-tertiary">
          no text — see what came with it
        </div>
      )}
    </blockquote>
  );
}
