import { Reply } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { AgentAvatar } from './AgentAvatar';
import { MessageMarkdown } from './MessageMarkdown';
import { ImageLightbox, type LightboxImage } from './ImageLightbox';
import { QuotedBlock } from './QuotedBlock';
import { VoiceMessage } from './VoiceMessage';
import { formatClock } from '../lib/format';
import { authorLabel, isMine, EMPTY_DIRECTORY, type Directory } from '../primitives/author';
import { chatImageUrl, imageName, inlineImagePaths } from '../primitives/chat-image';
import {
  parseQuotedMessage,
  quoteOfMessage,
  type MessageQuote,
} from '../primitives/quoted-context';
import { parseDictatedMessage } from '../primitives/dictation';
import type { Message } from '../primitives/message';

interface MessageItemProps {
  message: Message;
  /**
   * Who is who. A chat can be written from the browser by one account and
   * from Telegram by another, so a message says which — `you (name)` for the
   * signed-in account, the other person's name (or email) otherwise.
   */
  directory?: Directory;
  /**
   * `chat` (default) — Direction-B chat card. `log` — run-log styling
   * (design v3 .log-agent-card): violet left accent + mono body, no avatar.
   */
  variant?: 'chat' | 'log';
  /**
   * The conversation on screen. Given, a path the agent wrote is drawn as the
   * picture it names and opens full screen from here; omitted (the run log),
   * the message reads exactly as before.
   */
  conversationId?: string;
  /**
   * Take this message as the composer's quote. Absent (the run log, a static
   * render) there is no reply affordance at all.
   */
  onReply?: (quote: MessageQuote) => void;
}

const ERROR_BLOCK = (msg: string): ReactElement => (
  <div className="mt-2 rounded border border-error/40 bg-error/10 px-2 py-1.5 font-mono text-[12px] text-error">
    {msg}
  </div>
);

/**
 * Direction-B chat row. Role-branched:
 *  - `user` → meta line + right-aligned outlined-magenta bubble (all lengths).
 *  - `assistant`/`system` → meta line + 30px gradient-ring avatar + soft
 *    surface-elevated card containing the markdown body.
 *
 * Borders use inline `style.borderColor` because the console scope has a
 * wildcard `border-color: var(--border)` rule that would repaint Tailwind's
 * border-utility colors otherwise (see `theme.css`, mirrored in
 * `StreamCard.tsx`).
 */
export function MessageItem({
  message,
  variant = 'chat',
  directory = EMPTY_DIRECTORY,
  conversationId,
  onReply,
}: MessageItemProps): ReactElement {
  const kind = message.role;
  const author = authorLabel(directory, message.userId);
  // What the writer quoted travels inside the text, so it is split back out
  // here: the blocks are drawn as quotes, and only what is left is the message.
  const quoted = useMemo(() => parseQuotedMessage(message.content.trim()), [message.content]);
  const quotes = quoted.quotes;
  // A dictated message says so on its first line, after any quotes. Taken off
  // here so the row can draw the recording and fold the words under it; a typed
  // message comes back byte for byte and renders exactly as it always has.
  const spoken = useMemo(() => parseDictatedMessage(quoted.body), [quoted.body]);
  const content = spoken.body;
  const clock = formatClock(message.timestamp);
  const log = variant === 'log';

  const mine = isMine(directory, message.userId);
  const replyButton =
    onReply === undefined ? null : (
      <button
        type="button"
        onClick={() => {
          onReply(quoteOfMessage(message.content, message.role, author, mine));
        }}
        aria-label="Reply to this message"
        title="Reply"
        className="rounded p-[2px] text-text-tertiary opacity-0 transition-[opacity,color] hover:bg-[color:var(--surface-hover)] hover:text-text-primary focus-visible:opacity-100 group-hover/message:opacity-100"
      >
        <Reply className="h-[13px] w-[13px]" />
      </button>
    );

  // The lightbox walks the pictures of THIS message, in the order it shows
  // them — the same shape the artifact panel hands it.
  const [openImage, setOpenImage] = useState<string | null>(null);
  const images: LightboxImage[] = useMemo(
    () =>
      conversationId === undefined
        ? []
        : inlineImagePaths(content).map(path => ({
            id: path,
            name: imageName(path),
            url: chatImageUrl(conversationId, path),
          })),
    [conversationId, content]
  );
  const openIndex = images.findIndex(image => image.id === openImage);
  const onOpenImage = useCallback((path: string) => {
    setOpenImage(path);
  }, []);

  if (kind === 'user') {
    return (
      <div className="group/message flex flex-col items-end">
        <header className="mb-2 flex flex-row-reverse items-center gap-[9px] font-mono">
          <span
            className="max-w-[260px] truncate rounded px-[7px] py-[2px] text-[10px] font-bold uppercase tracking-[0.14em]"
            title={author ?? undefined}
            style={{
              color: 'var(--brand-magenta)',
              background: 'color-mix(in oklch, var(--brand-magenta), transparent 88%)',
            }}
          >
            {author ?? 'You'}
          </span>
          <time
            dateTime={message.timestamp}
            title={clock}
            className="text-[11px] tracking-[0.3px] text-text-tertiary"
          >
            {clock}
          </time>
          {replyButton}
        </header>
        {quotes.length > 0 ? (
          <div className="mb-[7px] max-w-[76%] self-end">
            {quotes.map((quote, index) => (
              <QuotedBlock key={index} quote={quote} />
            ))}
          </div>
        ) : null}
        <div
          className="max-w-[76%] self-end rounded-[14px_14px_4px_14px] px-[17px] py-[13px] text-[14.5px] leading-[1.5] break-words"
          style={{
            background: 'color-mix(in oklch, var(--brand-magenta), transparent 94%)',
            border: '1px solid color-mix(in oklch, var(--brand-magenta), transparent 50%)',
            color: 'color-mix(in oklch, white, var(--brand-magenta) 12%)',
            boxShadow: '0 0 0 4px color-mix(in oklch, var(--brand-magenta), transparent 95%)',
          }}
        >
          {spoken.note === null ? (
            content
          ) : (
            <VoiceMessage
              note={spoken.note}
              transcript={content}
              recording={message.files.find(f => f.mimeType.startsWith('audio/'))}
            />
          )}
        </div>
        {message.error !== null ? ERROR_BLOCK(message.error.message) : null}
      </div>
    );
  }

  const label = kind === 'system' ? 'System' : 'Agent';

  return (
    <div className="group/message flex flex-col">
      <header className="mb-2 flex items-center gap-[9px] font-mono">
        <span
          className="rounded px-[7px] py-[2px] text-[10px] font-bold uppercase tracking-[0.14em]"
          style={{
            color: 'var(--brand-teal)',
            background: 'color-mix(in oklch, var(--brand-teal), transparent 88%)',
          }}
        >
          {label}
        </span>
        <time
          dateTime={message.timestamp}
          title={clock}
          className="text-[11px] tracking-[0.3px] text-text-tertiary"
        >
          {clock}
        </time>
        {replyButton}
      </header>
      <div className="flex max-w-full items-start gap-[13px]">
        {log ? null : (
          <div className="shrink-0">
            <AgentAvatar size={30} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div
            className="rounded-[12px] border bg-[color:var(--surface-elevated)] px-4 py-[14px]"
            style={
              log
                ? {
                    borderColor: 'var(--border)',
                    borderLeft: '3px solid var(--brand-violet)',
                  }
                : { borderColor: 'var(--border)' }
            }
          >
            {quotes.map((quote, index) => (
              <QuotedBlock key={index} quote={quote} />
            ))}
            {content.length > 0 ? (
              <div
                className={
                  log
                    ? 'max-w-none font-mono text-[12px] leading-[1.7] text-text-secondary'
                    : 'max-w-none text-[14.5px] leading-[1.62] text-text-primary'
                }
              >
                <MessageMarkdown
                  content={content}
                  conversationId={conversationId}
                  onOpenImage={conversationId === undefined ? undefined : onOpenImage}
                />
              </div>
            ) : null}
            {message.error !== null ? ERROR_BLOCK(message.error.message) : null}
          </div>
        </div>
      </div>
      {openIndex !== -1 ? (
        <ImageLightbox
          images={images}
          index={openIndex}
          onIndex={i => {
            setOpenImage(images[i]?.id ?? null);
          }}
          onClose={() => {
            setOpenImage(null);
          }}
        />
      ) : null}
    </div>
  );
}
