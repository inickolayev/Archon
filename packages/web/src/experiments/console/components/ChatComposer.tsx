import { Paperclip } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import {
  ACCEPTED_EXTENSIONS,
  MAX_FILES,
  attachFiles,
  isImageFile,
  transferredFiles,
  type Attachment,
  type AttachmentMeta,
} from '../primitives/file';
import { moveItem } from '../primitives/reorder';
import { formatQuotedMessage, type MessageQuote } from '../primitives/quoted-context';
import { ChatAttachments } from './ChatAttachments';
import { ImageLightbox, type LightboxImage } from './ImageLightbox';
import { QuotedBlock } from './QuotedBlock';

interface ChatComposerProps {
  onSend: (message: string, files?: File[]) => void;
  disabled: boolean;
  disabledReason?: string;
  /**
   * The message this send is replying to, picked from the stream. It rides
   * inside the sent text as a labelled blockquote — the same shape a Telegram
   * reply produces — so both windows and the agent read one thing.
   */
  quote?: MessageQuote | null;
  /** Drop the pending quote. Bound to the strip's ✕ and to Escape. */
  onCancelQuote?: () => void;
}

const MAX_HEIGHT = 200;

/**
 * Console-native chat composer. Auto-growing textarea, Enter sends,
 * Shift+Enter newline, Escape blurs. Attach files with the paperclip icon, by
 * pasting them into the textarea (Cmd/Ctrl+V of a screenshot) or by dropping
 * them anywhere on the composer (the send skill builds the multipart upload).
 * Attachments show as chips with an image thumbnail, open full screen on a
 * click and can be dragged into the order they should be sent in.
 *
 * Reimplemented (not imported) from the old chat's MessageInput because the
 * console may not import production `@/components/**` (ESLint isolation rule).
 *
 * Direction-B `cbox` shell: rounded card with `:focus-within` magenta ring,
 * paperclip attach + decorative `/` lead buttons, gradient `.brand-bar` Send
 * button + glow, kbd-hint row beneath. Attached files render as removable
 * chips above.
 */
export function ChatComposer({
  onSend,
  disabled,
  disabledReason,
  quote = null,
  onCancelQuote,
}: ChatComposerProps): ReactElement {
  const [value, setValue] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const idRef = useRef(0);
  // Thumbnails are object URLs: the browser keeps the blob alive until each one
  // is revoked, so every path that drops an attachment revokes it, and unmount
  // sweeps whatever is left.
  //
  // `filesRef` — not the `files` render snapshot — is what every mutation reads
  // and writes: two batches landing in the same tick (two quick pastes, a paste
  // then a drop) have to build on each other. Reading the snapshot made both
  // start from the same stale list, so the earlier batch was silently lost.
  const filesRef = useRef<Attachment[]>([]);

  const setAttachments = (next: readonly Attachment[]): void => {
    filesRef.current = [...next];
    setFiles(filesRef.current);
  };

  useEffect(
    () => (): void => {
      for (const f of filesRef.current)
        if (f.previewUrl !== null) URL.revokeObjectURL(f.previewUrl);
    },
    []
  );

  // Picking a message to reply to is a request to type: land the caret in the
  // box rather than making the operator click it after every reply.
  useEffect(() => {
    if (quote !== null) textareaRef.current?.focus();
  }, [quote]);

  const grow = (el: HTMLTextAreaElement): void => {
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, MAX_HEIGHT);
    el.style.height = `${next.toString()}px`;
    el.style.overflowY = next >= MAX_HEIGHT ? 'auto' : 'hidden';
  };

  const mintAttachment = (file: File): AttachmentMeta => ({
    id: String(idRef.current++),
    previewUrl: isImageFile(file) ? URL.createObjectURL(file) : null,
  });

  const addFiles = (incoming: File[]): void => {
    const { next, skipped } = attachFiles(filesRef.current, incoming, mintAttachment);
    setAttachments(next);
    setFileError(
      skipped.length > 0
        ? `Skipped ${String(skipped.length)} file(s) — ${skipped.join('; ')}`
        : null
    );
  };

  const removeFile = (id: string): void => {
    const gone = filesRef.current.find(f => f.id === id);
    if (gone === undefined) return;
    // Revoked here rather than inside a state updater: React re-runs updaters
    // (StrictMode does it on purpose), which would revoke the same URL twice.
    if (gone.previewUrl !== null) URL.revokeObjectURL(gone.previewUrl);
    setAttachments(filesRef.current.filter(f => f.id !== id));
    setPreviewId(current => (current === id ? null : current));
    setFileError(null);
  };

  const reorderFiles = (from: number, to: number): void => {
    setAttachments(moveItem(filesRef.current, from, to));
  };

  const clearFiles = (): void => {
    for (const f of filesRef.current) if (f.previewUrl !== null) URL.revokeObjectURL(f.previewUrl);
    setAttachments([]);
    setPreviewId(null);
  };

  const submit = (): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || disabled) return;
    const attached = filesRef.current;
    // With nothing quoted this is byte-for-byte what was typed.
    const text = formatQuotedMessage(quote === null ? [] : [quote], trimmed);
    onSend(text, attached.length > 0 ? attached.map(f => f.file) : undefined);
    onCancelQuote?.();
    setValue('');
    clearFiles();
    setFileError(null);
    if (fileInputRef.current !== null) fileInputRef.current.value = '';
    if (textareaRef.current !== null) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Don't submit while an IME composition is in progress (Japanese,
    // Chinese, Korean, etc. — the first Enter accepts a candidate).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'Escape') {
      // A pending quote is the first thing Escape undoes: losing focus with the
      // quote still armed is the version of this that sends the wrong message.
      if (quote !== null && onCancelQuote !== undefined) {
        e.preventDefault();
        onCancelQuote();
        return;
      }
      e.currentTarget.blur();
    }
  };

  // Paste of a screenshot or a copied file. A text paste carries only string
  // items, so the textarea keeps its default behaviour.
  const onPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>): void => {
    if (disabled) return;
    const pasted = transferredFiles(e.clipboardData.items);
    if (pasted.length === 0) return;
    e.preventDefault();
    addFiles(pasted);
  };

  const onDragOver = (e: ReactDragEvent<HTMLDivElement>): void => {
    if (disabled || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragOver) setDragOver(true);
  };

  const onDragLeave = (e: ReactDragEvent<HTMLDivElement>): void => {
    // Only un-flag when leaving the bounding rect, not on each child crossover.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOver(false);
  };

  const onDrop = (e: ReactDragEvent<HTMLDivElement>): void => {
    if (disabled) return;
    e.preventDefault();
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length > 0) addFiles(dropped);
  };

  // The lightbox steps through the attached images only, in chip order.
  const images: LightboxImage[] = files.flatMap(f =>
    f.previewUrl === null ? [] : [{ id: f.id, name: f.file.name, url: f.previewUrl }]
  );
  const previewIndex = images.findIndex(f => f.id === previewId);
  const preview = previewIndex === -1 ? null : previewIndex;

  return (
    <div
      className="relative shrink-0 border-t border-border bg-surface px-[30px] py-[14px]"
      title={disabledReason}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragOver ? (
        <div
          aria-hidden
          className="brand-bar-soft pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
        >
          <span className="rounded border border-[color:var(--brand-magenta)] bg-surface px-3 py-1.5 font-mono text-[11px] text-[color:var(--brand-magenta)]">
            drop files to attach
          </span>
        </div>
      ) : null}
      <div className="mx-auto max-w-[940px]">
        {quote !== null ? (
          <div
            className="mb-[10px] flex items-center gap-[8px] rounded-[10px] border bg-[color:var(--surface-elevated)] py-[7px] pl-[10px] pr-[7px]"
            style={{ borderColor: 'var(--border-bright)' }}
          >
            <QuotedBlock quote={quote} variant="composer" />
            <button
              type="button"
              onClick={onCancelQuote}
              aria-label="Cancel reply"
              title="Cancel reply · Esc"
              className="ml-auto shrink-0 rounded p-[2px] text-text-tertiary transition-colors hover:bg-[color:var(--surface-hover)] hover:text-text-primary"
            >
              <span aria-hidden className="text-[11px] leading-none">
                ✕
              </span>
            </button>
          </div>
        ) : null}
        {files.length > 0 ? (
          <ChatAttachments
            files={files}
            onRemove={removeFile}
            onReorder={reorderFiles}
            onOpen={setPreviewId}
          />
        ) : null}
        {fileError !== null ? (
          <div className="mb-[8px] font-mono text-[11px] text-error">{fileError}</div>
        ) : null}
        <div
          className="flex items-end gap-[10px] rounded-[14px] border bg-[color:var(--surface-elevated)] py-[8px] pl-[14px] pr-[8px] transition-[border-color,box-shadow] focus-within:border-[color:color-mix(in_oklch,var(--brand-magenta),transparent_40%)] focus-within:shadow-[0_0_0_4px_color-mix(in_oklch,var(--brand-magenta),transparent_92%)]"
          style={{ borderColor: 'var(--border-bright)' }}
        >
          <div className="flex shrink-0 items-end gap-[6px] pb-[7px] text-text-tertiary">
            <button
              type="button"
              onClick={() => {
                fileInputRef.current?.click();
              }}
              aria-label="Attach files"
              disabled={disabled || files.length >= MAX_FILES}
              title="Attach files"
              className="flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-[color:var(--surface-hover)] hover:text-text-primary disabled:cursor-default disabled:opacity-50"
            >
              <Paperclip className="h-5 w-5" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPTED_EXTENSIONS}
              className="hidden"
              onChange={e => {
                if (e.target.files !== null) addFiles(Array.from(e.target.files));
              }}
            />
            <button
              type="button"
              tabIndex={-1}
              aria-label="Commands"
              disabled
              title="Commands (coming soon)"
              className="flex h-[22px] items-center justify-center rounded-md px-[2px] text-[17px] leading-none transition-colors hover:bg-[color:var(--surface-hover)] hover:text-text-primary disabled:cursor-default disabled:opacity-50"
            >
              /
            </button>
          </div>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={e => {
              setValue(e.target.value);
              grow(e.target);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            placeholder={disabled ? (disabledReason ?? 'Waiting…') : 'Message the agent…'}
            className="min-h-0 flex-1 resize-none bg-transparent py-[7px] text-[14.5px] leading-[1.5] text-text-primary placeholder:text-text-tertiary focus:outline-none disabled:opacity-50"
            style={{ maxHeight: `${MAX_HEIGHT.toString()}px` }}
          />
          <button
            type="button"
            onClick={submit}
            disabled={disabled || value.trim().length === 0}
            title="Send · Enter"
            className="brand-bar flex h-[36px] shrink-0 items-center gap-[7px] rounded-[10px] px-[15px] text-[13px] font-bold text-white shadow-[0_6px_18px_-8px_color-mix(in_oklch,var(--brand-magenta),transparent_30%)] transition-[filter,transform] hover:brightness-110 active:translate-y-[1px] disabled:opacity-45 disabled:shadow-none disabled:hover:brightness-100"
          >
            Send
            <span aria-hidden className="font-mono text-[10px] opacity-70">
              ↵
            </span>
          </button>
        </div>
        <div className="mt-[9px] flex items-center justify-between px-[2px] font-mono text-[11px] text-text-tertiary">
          <span />
          <span>
            <span
              className="mr-1 inline-flex items-center rounded border px-[5px] py-[1px] font-mono text-[10.5px] text-text-secondary"
              style={{ borderColor: 'var(--border-bright)' }}
            >
              ↵
            </span>
            send{' '}
            <span
              className="ml-1 inline-flex items-center rounded border px-[5px] py-[1px] font-mono text-[10.5px] text-text-secondary"
              style={{ borderColor: 'var(--border-bright)' }}
            >
              ⇧↵
            </span>{' '}
            newline
          </span>
        </div>
      </div>
      {preview !== null ? (
        <ImageLightbox
          images={images}
          index={preview}
          onIndex={i => {
            setPreviewId(images[i]?.id ?? null);
          }}
          onClose={() => {
            setPreviewId(null);
          }}
        />
      ) : null}
    </div>
  );
}
