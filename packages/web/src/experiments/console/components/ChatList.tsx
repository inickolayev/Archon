import type { ReactElement } from 'react';
import { relativeTime } from '../lib/format';
import { conversationLabel, type ConversationSummary } from '../primitives/conversation';
import { authorLabel, EMPTY_DIRECTORY, type Directory } from '../primitives/author';
import { PlatformBadge } from './PlatformBadge';

interface ChatListProps {
  conversations: ConversationSummary[];
  /** The chat on screen, or null while an unsent new chat is open. */
  activeId: string | null;
  onSelect: (conversationId: string) => void;
  /** Who is who — a chat says whose it is when the answer is not obvious. */
  directory?: Directory;
}

/**
 * The project's chats, newest activity first. Pure presentation — the picker
 * (or any future sidebar) owns the popover and the routing.
 *
 * A conversation the server has not titled yet still gets a readable row
 * (`conversationLabel` falls back to when it was last active), so the list
 * never shows a blank line.
 *
 * Every platform of the project is listed, not just the console's own chats:
 * a conversation is born on one platform but is not owned by it. The badge
 * says which one it came from.
 */
export function ChatList({
  conversations,
  activeId,
  onSelect,
  directory = EMPTY_DIRECTORY,
}: ChatListProps): ReactElement {
  if (conversations.length === 0) {
    return (
      <p className="px-3 py-4 text-center text-[11px] text-text-tertiary">
        No chats in this project yet.
      </p>
    );
  }

  return (
    <ul className="flex max-h-[50vh] flex-col gap-px overflow-y-auto p-1.5">
      {conversations.map(conversation => {
        const isActive = conversation.id === activeId;
        return (
          <li key={conversation.id}>
            <button
              type="button"
              onClick={() => {
                onSelect(conversation.id);
              }}
              aria-current={isActive ? 'true' : undefined}
              className={`flex w-full flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left transition-colors ${
                isActive ? 'bg-surface-elevated' : 'hover:bg-surface-hover'
              }`}
            >
              <span className="flex items-center gap-1.5">
                <span
                  className={`truncate text-[12px] ${
                    isActive ? 'text-text-primary' : 'text-text-secondary'
                  }`}
                >
                  {conversationLabel(conversation)}
                </span>
              </span>
              <span className="flex items-center gap-1.5 font-mono text-[10px] text-text-tertiary">
                <PlatformBadge platformType={conversation.platformType} />
                <span>
                  {conversation.lastActivityAt !== null
                    ? relativeTime(conversation.lastActivityAt)
                    : 'not started'}
                </span>
                {authorLabel(directory, conversation.userId) !== null ? (
                  <span
                    className="truncate"
                    title={authorLabel(directory, conversation.userId) ?? ''}
                  >
                    · {authorLabel(directory, conversation.userId)}
                  </span>
                ) : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
