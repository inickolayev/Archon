import { useEffect, useRef, useState, type ReactElement } from 'react';
import { ChatList } from './ChatList';
import { PlatformBadge } from './PlatformBadge';
import { conversationLabel, type ConversationSummary } from '../primitives/conversation';
import type { Directory } from '../primitives/author';

interface ChatPickerProps {
  conversations: ConversationSummary[];
  /** The chat on screen, or null while an unsent new chat is open. */
  activeId: string | null;
  onSelect: (conversationId: string) => void;
  onNewChat: () => void;
  /** Who is who — the list says whose chat each row is. */
  directory?: Directory;
}

/**
 * Chat switcher for the chat header: the current chat's name opens a popover
 * with the project's other chats, and `New chat` opens an empty one.
 *
 * A popover rather than a column: the chat page is already narrow, and this
 * has to stay usable at phone width — the panel is capped to the viewport and
 * anchored to the button.
 *
 * Nothing is created here. `New chat` only navigates; the conversation is
 * created by the first send, so clicking it ten times leaves no rows behind.
 */
export function ChatPicker({
  conversations,
  activeId,
  onSelect,
  onNewChat,
  directory,
}: ChatPickerProps): ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return (): void => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const active = conversations.find(c => c.id === activeId) ?? null;
  const label =
    activeId === null ? 'New chat' : active !== null ? conversationLabel(active) : 'This chat';

  return (
    <div ref={rootRef} className="relative flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        onClick={() => {
          setOpen(v => !v);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch chat"
        className="flex max-w-[220px] items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:text-text-primary"
        style={{ borderColor: 'var(--border-bright)' }}
      >
        {active !== null ? <PlatformBadge platformType={active.platformType} hideWeb /> : null}
        <span className="truncate">{label}</span>
        <span aria-hidden className="font-mono text-[9px] text-text-tertiary">
          ▾
        </span>
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          onNewChat();
        }}
        title="Start a new chat"
        className="rounded-md border px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:text-text-primary"
        style={{ borderColor: 'var(--border-bright)' }}
      >
        + New chat
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Project chats"
          className="absolute right-0 top-full z-30 mt-1.5 w-[min(320px,calc(100vw-40px))] rounded-lg border bg-[color:var(--surface-elevated)] shadow-lg"
          style={{ borderColor: 'var(--border-bright)' }}
        >
          <ChatList
            conversations={conversations}
            activeId={activeId}
            directory={directory}
            onSelect={id => {
              setOpen(false);
              onSelect(id);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
