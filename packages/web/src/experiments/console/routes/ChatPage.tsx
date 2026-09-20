import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ChatStream } from '../components/ChatStream';
import { ChatComposer } from '../components/ChatComposer';
import { ChatPicker } from '../components/ChatPicker';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import { WorkingIndicator } from '../components/WorkingIndicator';
import { WorkflowDock } from '../components/WorkflowDock';
import { EmptyState } from '../components/EmptyState';
import { StreamContextProvider } from '../lib/stream-context';
import { useConversationSSE } from '../lib/sse';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import { ensureUtc } from '../lib/format';
import type { Project } from '../primitives/project';
import type { Message } from '../primitives/message';
import type { ConversationSummary } from '../primitives/conversation';
import { EMPTY_DIRECTORY, type Directory } from '../primitives/author';

// While a turn is active, refetch messages on this cadence so streamed replies
// still surface if a per-conversation SSE event is dropped (cross-origin
// EventSource in dev can miss bursts). Mirrors RunDetailPage's safety-net poll.
const ACTIVE_POLL_MS = 3000;
// Consider the turn done once the trailing message is an assistant reply that
// has stayed stable this long. Independent of any SSE lock event.
const SETTLE_MS = 6000;
// Hard cap so a turn that never produces a reply (server error, etc.) can't
// disable the composer forever.
const MAX_WAIT_MS = 300_000;
// Distance from the bottom (px) within which we treat the scroll as "at bottom"
// — drives both auto-scroll stickiness and the jump-to-bottom button's visibility.
const NEAR_BOTTOM_PX = 120;
// URL segment for a chat that exists only on screen: nothing is created until
// the first send, so `New chat` is a route, not a write.
const NEW_CHAT_SEGMENT = 'new';

/** Sort key for the chat list: never-used chats sink to the bottom. */
function activityMs(conversation: ConversationSummary): number {
  if (conversation.lastActivityAt === null) return 0;
  const ms = new Date(ensureUtc(conversation.lastActivityAt)).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Project-scoped agent chat. A tab peer of the runs view under a project.
 *
 * A project can hold many chats. The one on screen is named by the URL
 * (`/console/p/:projectId/chat/:conversationId`), so a reload or the Back
 * button returns to the same chat instead of silently landing on another;
 * `/chat` with no id redirects to the most recent one, and `/chat/new` is an
 * empty chat that becomes real on its first send (creation stays lazy — the
 * button can be pressed all day without writing a row).
 *
 * Everything the composer shows — busy, the send error, the attachment chips —
 * belongs to the conversation on screen and is reset when it changes, so no
 * state leaks from one chat into another.
 *
 * Data flow mirrors RunDetailPage: load messages via useEntity(K.messages),
 * keep live via useConversationSSE (invalidate → refetch), render with the
 * shared MessageItem/ToolCallItem cards inside a StreamContextProvider.
 */
export function ChatPage(): ReactElement {
  const { projectId, conversationId } = useParams<{
    projectId: string;
    conversationId?: string;
  }>();
  const navigate = useNavigate();

  const { data: project } = useEntity<Project | null>(
    projectId !== undefined ? K.project(projectId) : 'noop:no-project',
    () => (projectId !== undefined ? skill.getProject(projectId) : Promise.resolve(null))
  );

  // Who wrote what. Shared by the chat list and the message headers so the
  // same person reads the same way in both. A failure here is cosmetic: the
  // labels fall back to the plain role names.
  const { data: directoryData } = useEntity<Directory>(K.directory, () => skill.getDirectory());
  const directory = directoryData ?? EMPTY_DIRECTORY;

  const { data: conversations, error: conversationsError } = useEntity<ConversationSummary[]>(
    projectId !== undefined ? K.conversations(projectId) : 'noop:no-project-convs',
    () => (projectId !== undefined ? skill.listConversations(projectId) : Promise.resolve([]))
  );

  // Every conversation of the project, whatever platform it was born on: a
  // chat started in Telegram continues here and vice versa. Sorted by last
  // activity rather than trusting the API's order — "the most recent chat" is
  // what a bare /chat adopts, so it has to be true.
  const projectConversations = useMemo(
    () => (conversations ?? []).slice().sort((a, b) => activityMs(b) - activityMs(a)),
    [conversations]
  );

  // The URL is the source of truth. `new` (or an id we have not been given)
  // means "unsent chat" — null until the first send creates one.
  const activeConvId =
    conversationId === undefined || conversationId === NEW_CHAT_SEGMENT ? null : conversationId;

  const chatPath = useCallback(
    (segment: string): string => `/console/p/${projectId ?? ''}/chat/${segment}`,
    [projectId]
  );

  // Bare `/chat` adopts the most recent chat and puts it in the URL (replace,
  // so Back still leaves the chat rather than bouncing between the two forms).
  useEffect(() => {
    if (conversationId !== undefined || projectId === undefined) return;
    const latest = projectConversations[0];
    if (latest !== undefined) navigate(chatPath(latest.id), { replace: true });
  }, [conversationId, projectId, projectConversations, navigate, chatPath]);

  const { data: messages, error: messagesError } = useEntity<Message[]>(
    activeConvId !== null ? K.messages(activeConvId) : 'noop:no-conv',
    () => (activeConvId !== null ? skill.listMessages(activeConvId) : Promise.resolve([]))
  );

  // `busy` = a reply is pending → composer disabled + recovery poll active.
  // Driven by message content and the send action, NOT by the SSE lock event,
  // so it stays correct even when the per-conversation SSE drops or never
  // connects (which it can, cross-origin in dev). SSE is a pure accelerator.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Non-error advisory (distinct channel from `error` so it doesn't read as a
  // send failure) — e.g. files dropped from a first message.
  const [notice, setNotice] = useState<string | null>(null);

  // Turn-completion state. The settle timer (below) is the correctness floor — it
  // works even when SSE is absent. The SSE lock event is a fast-path on top of it.
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleSigRef = useRef('');

  // Read inside callbacks that must not re-subscribe the SSE stream on every
  // conversation switch (see onLockChange below).
  const activeConvIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeConvIdRef.current = activeConvId;
  }, [activeConvId]);

  // End of a turn, from either detector. The refetch matters: the recovery poll
  // stops the moment `busy` clears, and the lock can be released a beat after
  // the reply row is written — a poll that raced ahead of that write would
  // otherwise leave the answer invisible until a reload (seen on the first turn
  // of a freshly created chat).
  const finishTurn = useCallback((): void => {
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    setBusy(false);
    const id = activeConvIdRef.current;
    if (id !== null) invalidate(K.messages(id));
  }, []);

  // SSE accelerator: invalidates the message cache on text/tool events, and via
  // onLockChange ends the turn the instant the server releases the conversation
  // lock (conversation_lock:false) instead of waiting out SETTLE_MS. Must be
  // useCallback-stable — the hook's effect depends on it, so an inline lambda
  // would reconnect the EventSource on every render.
  const onLockChange = useCallback(
    (locked: boolean): void => {
      if (locked) return;
      finishTurn();
    },
    [finishTurn]
  );
  useConversationSSE(activeConvId, onLockChange);

  // Derive turn state from the trailing message: a user message means a reply
  // is pending; once an assistant reply lands and stays stable for SETTLE_MS the
  // turn is done. This also recovers a reload mid-turn (trailing user message).
  useEffect(() => {
    const list = messages ?? [];
    const last = list[list.length - 1];
    if (last === undefined) return;
    if (last.role === 'user') {
      settleSigRef.current = '';
      if (settleTimerRef.current !== null) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      setBusy(true);
      return;
    }
    // Trailing message is an assistant/system reply. Arm the settle timer once;
    // re-arm only on real content change so identical poll refetches (same sig)
    // don't reset it forever.
    const sig = `${list.length}:${last.id}`;
    if (sig === settleSigRef.current) return;
    settleSigRef.current = sig;
    if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => {
      finishTurn();
    }, SETTLE_MS);
  }, [messages, finishTurn]);
  useEffect(
    () => (): void => {
      if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    },
    []
  );

  // Switching chats: drop everything that described the previous one. `busy` is
  // re-derived from the new chat's trailing message by the effect above, so a
  // chat that is mid-turn still comes back locked. The one case we must not
  // reset is the switch we make ourselves right after creating a conversation —
  // its first message is already in flight.
  const justCreatedRef = useRef<string | null>(null);
  useEffect(() => {
    if (justCreatedRef.current !== null && justCreatedRef.current === activeConvId) {
      justCreatedRef.current = null;
      return;
    }
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    settleSigRef.current = '';
    setBusy(false);
    setError(null);
    setNotice(null);
  }, [activeConvId]);

  // Recovery poll: while a reply is pending, refetch messages on a cadence so a
  // dropped or absent SSE event can't hide the reply. Hard-caps at MAX_WAIT_MS.
  const busySinceRef = useRef(0);
  useEffect(() => {
    if (!busy || activeConvId === null) return;
    busySinceRef.current = Date.now();
    const id = setInterval(() => {
      if (Date.now() - busySinceRef.current > MAX_WAIT_MS) {
        setBusy(false);
        return;
      }
      invalidate(K.messages(activeConvId));
    }, ACTIVE_POLL_MS);
    return (): void => {
      clearInterval(id);
    };
  }, [busy, activeConvId]);

  // Reveal the raw tool trace inline (toggled from the working indicator).
  const [showTools, setShowTools] = useState(false);

  const onSend = (text: string, files?: File[]): void => {
    if (projectId === undefined) return;
    setError(null);
    setNotice(null);
    setBusy(true); // optimistic: disable the composer immediately
    void (async (): Promise<void> => {
      try {
        if (activeConvId === null) {
          const conv = await skill.createConversation(projectId, text);
          justCreatedRef.current = conv.conversationId;
          // Replace: the unsent `/chat/new` entry is not worth a Back step.
          navigate(chatPath(conv.conversationId), { replace: true });
          invalidate(K.conversations(projectId));
          invalidate(K.messages(conv.conversationId));
          // createConversation is JSON-only — files can't ride the first message.
          // Surface it as a non-error notice (not silently dropped); phrased so
          // it's actionable once the agent replies (the composer is locked while
          // `busy`), not "now".
          if (files !== undefined && files.length > 0) {
            setNotice(
              "Files aren't attached to the first message of a new chat — re-attach and send them once the chat has started."
            );
          }
        } else {
          await skill.sendMessage(activeConvId, text, files);
          invalidate(K.messages(activeConvId));
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Send failed.');
        setBusy(false); // unblock so the user can retry
      }
      // On success `busy` stays true until the settle detector sees the reply.
    })();
  };

  // Inline auto-scroll: stick to bottom on new messages if already near it.
  // Mirrors RunDetailPage's variant.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    lastBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  });
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || !lastBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages?.length]);

  // Jump-to-bottom affordance: `atBottom` (state) drives the button's visibility;
  // `lastBottomRef` (above) drives the auto-scroll stickiness. Keep them in sync.
  const [atBottom, setAtBottom] = useState(true);
  const handleScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    lastBottomRef.current = near;
    setAtBottom(near);
  }, []);
  const scrollToBottom = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  }, []);

  if (projectId === undefined) {
    return <EmptyState title="No project selected." />;
  }

  const messageList = messages ?? [];

  // Surface a failed (re)load of the conversation list or message history — a
  // revalidation can fail silently (network blip, server restart) and otherwise
  // leave stale/empty data with no signal. Send errors take precedence.
  const loadError = messagesError ?? conversationsError;

  // Current activity for the working indicator: the latest tool the agent
  // invoked in the in-flight turn (walk back to the last user message).
  const currentActivity = useMemo<string | null>(() => {
    for (let i = messageList.length - 1; i >= 0; i--) {
      const m = messageList[i];
      if (m === undefined) continue;
      if (m.role === 'user') break;
      if (m.role === 'assistant' && m.toolCalls.length > 0) {
        return m.toolCalls[m.toolCalls.length - 1]?.name ?? null;
      }
    }
    return null;
  }, [messageList]);

  return (
    <section className="flex h-full flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-6 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-base font-medium text-text-primary">
              {project?.name ?? 'Project'}
            </h1>
            <p className="text-xs text-text-tertiary">{project?.path ?? 'Loading…'}</p>
          </div>
          <ChatPicker
            conversations={projectConversations}
            activeId={activeConvId}
            directory={directory}
            onSelect={id => {
              navigate(chatPath(id));
            }}
            onNewChat={() => {
              navigate(chatPath(NEW_CHAT_SEGMENT));
            }}
          />
        </div>
        <ProjectViewTabs projectId={projectId} active="chat" />
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto px-[30px] pt-[26px] pb-[18px]"
        >
          {/* Match the composer's centered 940px column (design: .stream-inner) */}
          <div className="mx-auto max-w-[940px]">
            {messageList.length === 0 && !busy ? (
              activeConvId === null ? (
                <EmptyState
                  title="New chat."
                  hint="It starts when you send the first message — nothing is saved before that."
                />
              ) : (
                <EmptyState
                  title="No messages yet."
                  hint="Ask the agent about this project, or tell it what to run."
                />
              )
            ) : (
              <StreamContextProvider value={{ runStartedAt: null }}>
                <ChatStream
                  messages={messageList}
                  showTools={showTools}
                  directory={directory}
                  conversationId={activeConvId ?? undefined}
                />
                {busy ? (
                  <WorkingIndicator
                    activity={currentActivity}
                    expanded={showTools}
                    onToggle={() => {
                      setShowTools(v => !v);
                    }}
                  />
                ) : null}
              </StreamContextProvider>
            )}
          </div>
        </div>
        {!atBottom ? (
          <button
            type="button"
            onClick={scrollToBottom}
            aria-label="Jump to bottom"
            className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-surface-elevated px-3 py-1 text-[11px] text-text-secondary shadow-md transition-colors hover:text-text-primary"
          >
            <span aria-hidden>↓</span>
            Jump to bottom
          </button>
        ) : null}
      </div>

      <WorkflowDock projectId={projectId} />

      {notice !== null ? (
        <div className="shrink-0 border-t border-warning/30 bg-warning/[0.06] px-6 py-2 font-mono text-[11px] text-warning">
          {notice}
        </div>
      ) : null}

      {error !== null || loadError !== undefined ? (
        <div className="shrink-0 border-t border-error/30 bg-error/[0.06] px-6 py-2 font-mono text-[11px] text-error">
          {error ?? `Failed to load chat: ${loadError?.message ?? 'unknown error'}`}
        </div>
      ) : null}

      {/* Keyed by conversation: a chat switch remounts the composer, so a draft
          or an attachment chip can never follow you into another chat (the
          unmount also revokes the thumbnails' object URLs). */}
      <ChatComposer key={activeConvId ?? NEW_CHAT_SEGMENT} onSend={onSend} disabled={busy} />
    </section>
  );
}
