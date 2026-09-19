import {
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

interface CodeBlockProps {
  /** The `<code>` element react-markdown puts inside the fenced block. */
  children?: ReactNode;
}

const COPIED_MS = 1500;

/**
 * The language of a fenced block, from the `language-…` class react-markdown
 * (and rehype-highlight) put on the inner `<code>`. `null` for a plain fence.
 */
function blockLanguage(children: ReactNode): string | null {
  if (!isValidElement<{ className?: string }>(children)) return null;
  const className = children.props.className ?? '';
  const match = /language-([\w+#.-]+)/.exec(className);
  return match?.[1] ?? null;
}

/**
 * A fenced code block with a copy button in its top-right corner.
 *
 * The text is read off the rendered `<pre>` at click time rather than
 * reconstructed from react-markdown's children: what the operator sees is
 * exactly what lands on the clipboard, trailing newline included, and no
 * button label can leak into it (the button lives outside the `<pre>`).
 *
 * The button is invisible until the block is hovered or something inside it
 * takes focus, but it is always in the tab order — keyboard users reach it
 * without a pointer. Clipboard access can be missing or refused (an insecure
 * origin, a denied permission), so a failure is shown, never swallowed.
 *
 * Borders are set inline: the console scope has a wildcard `border-color`
 * rule that repaints Tailwind border utilities (see `theme.css`).
 */
export function CodeBlock({ children }: CodeBlockProps): ReactElement {
  const preRef = useRef<HTMLPreElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const language = blockLanguage(children);

  useEffect(
    () => (): void => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    []
  );

  const flash = (next: 'copied' | 'failed'): void => {
    setState(next);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setState('idle');
    }, COPIED_MS);
  };

  const copy = (): void => {
    const text = preRef.current?.textContent ?? '';
    const write = async (): Promise<void> => {
      // `navigator.clipboard` is undefined on an insecure origin, and
      // writeText can still reject when the permission is denied.
      const clipboard = navigator.clipboard as Clipboard | undefined;
      if (clipboard === undefined) throw new Error('Clipboard unavailable');
      await clipboard.writeText(text);
    };
    write().then(
      () => {
        flash('copied');
      },
      () => {
        flash('failed');
      }
    );
  };

  const label =
    state === 'copied' ? 'Code copied' : state === 'failed' ? 'Copying failed' : 'Copy code';

  return (
    <div className="group relative my-2">
      <pre
        ref={preRef}
        className="overflow-x-auto rounded border bg-surface-inset p-2 text-[12px] leading-relaxed [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-[12px]"
        style={{ borderColor: 'var(--border)' }}
      >
        {children}
      </pre>
      <div className="pointer-events-none absolute right-[6px] top-[6px] flex items-center gap-[6px]">
        {language !== null ? (
          <span className="rounded px-[5px] py-[1px] font-mono text-[10px] uppercase tracking-[0.12em] text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            {language}
          </span>
        ) : null}
        <button
          type="button"
          onClick={copy}
          aria-label={label}
          title={label}
          className={`pointer-events-auto rounded border bg-[color:var(--surface-elevated)] px-[7px] py-[2px] font-mono text-[10.5px] transition-opacity hover:text-text-primary focus:opacity-100 focus-visible:outline focus-visible:outline-1 group-hover:opacity-100 group-focus-within:opacity-100 ${
            state === 'idle' ? 'opacity-0' : 'opacity-100'
          } ${state === 'failed' ? 'text-error' : 'text-text-secondary'}`}
          style={{
            borderColor: state === 'failed' ? 'var(--error)' : 'var(--border-bright)',
          }}
        >
          {state === 'copied' ? 'copied' : state === 'failed' ? 'failed' : 'copy'}
        </button>
      </div>
    </div>
  );
}
