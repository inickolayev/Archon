/**
 * What the Telegram bot does with what it receives: buttons, typed and spoken
 * messages, photos and documents, and the stop gesture.
 *
 * A Telegram chat holds many conversations, each of which may also be open in
 * the browser, so every inbound message is persisted at ingest, mirrored onto
 * the web stream, and answered through an adapter chain that also feeds the
 * phone's own "agent is working" line.
 */

import { unlink } from 'fs/promises';
import type { TelegramAdapter } from '@archon/adapters';
import {
  commandForLabel,
  createTelegramChatStore,
  handleMessage,
  handleTelegramCallback,
  isStopCommand,
  isTurnRunning,
  NOTHING_RUNNING_NOTICE,
  persistInboundMessage,
  resolveActiveTelegramConversationId,
  setProjectForConversation,
  STOP_COMMAND,
  STOP_REQUESTED_NOTICE,
  stopTurn as stopConversationTurn,
  trailingTextNotice,
  type AttachedFile,
  type ConversationLockManager,
} from '@archon/core';
import * as conversationDb from '@archon/core/db/conversations';
import { createMessageErrorHandler, resolveUserId } from '../chat-host/inbound';
import { conversationImageRoots } from '../messaging/conversation-image-roots';
import { getLog } from '../server-log';
import { dictationFor } from '../voice/dictation';
import { withOutboundMirror } from './mirror';
import { accountLinkMessage, telegramAccess } from './telegram-access';
import { createTurnStatus, withTurnStatus } from './telegram-status';
import { persistTelegramFiles } from './telegram-uploads';
import type { WebAdapter } from './web';

export interface TelegramHandlerDeps {
  readonly lockManager: ConversationLockManager;
  /** The browser side of the same conversations: inbound and outbound are mirrored onto it. */
  readonly webAdapter: WebAdapter;
}

/** Register every handler and the authorizer on a not-yet-started Telegram adapter. */
export function wireTelegramHandlers(
  telegramAdapter: TelegramAdapter,
  { lockManager, webAdapter }: TelegramHandlerDeps
): void {
  // Without this an answer naming a screenshot arrives on the phone as a path
  // to a file the operator cannot reach. The roots come from the conversation
  // itself, so one chat's reply can never show another project's files.
  telegramAdapter.onImageRoots(conversationImageRoots);

  /**
   * Call off whatever this Telegram chat's active conversation is doing.
   *
   * Both the tapped button and the typed command land here, and neither goes
   * anywhere near the conversation lock — a stop that queued behind the turn
   * it is meant to interrupt would arrive after that turn had already
   * finished. A lookup failure falls back to the chat's legacy-shaped
   * conversation id, the same fallback the message handler uses.
   */
  const stopActiveTurn = async (chatId: string): Promise<boolean> => {
    let conversationId = chatId;
    try {
      conversationId = await resolveActiveTelegramConversationId(chatId);
    } catch (err) {
      getLog().error({ err, chatId }, 'telegram.stop_conversation_lookup_failed');
    }
    return stopConversationTurn(conversationId);
  };

  // A tapped button on the persistent keyboard arrives as ordinary text, and
  // the lists it opens are edited in place rather than re-sent.
  telegramAdapter.onCallback(async ({ data, chatId, userId: telegramUserId }) => {
    const store = createTelegramChatStore();
    return handleTelegramCallback({
      data,
      chatId,
      store,
      // The link is a one-time token for THIS Telegram sender, spent in the
      // browser by whoever is signed in there. The bot never learns which
      // account it ends up on until the console confirms back.
      issueAccountLink: async () => {
        if (telegramUserId === undefined) {
          return 'I could not tell who you are on Telegram — try again from the menu.';
        }
        // Same text an unlinked sender gets, from the same place: the menu
        // and the gate must not drift into two different handshakes.
        return accountLinkMessage({
          platformUserId: String(telegramUserId),
          chatId,
        });
      },
      bindProject: async projectName => {
        const conversationId = await resolveActiveTelegramConversationId(chatId);
        return setProjectForConversation(conversationId, projectName);
      },
      stopTurn: async () =>
        (await stopActiveTurn(chatId)) ? STOP_REQUESTED_NOTICE : NOTHING_RUNNING_NOTICE,
    });
  });

  // Register message handler (auth is handled internally by adapter)
  telegramAdapter.onMessage(
    async ({
      conversationId: chatId,
      message: rawMessage,
      userId: telegramUserId,
      displayName,
      files,
      sentAtMs,
      platformMessageId,
      voiceDurationSec,
    }) => {
      // A tap on the persistent keyboard is a plain message carrying the
      // button's label; translate it back into the command it stands for.
      const message = commandForLabel(rawMessage) ?? rawMessage;

      // Stop is answered here and goes no further: everything below this
      // point ends at `acquireLock`, where a stop would queue behind the very
      // turn it exists to interrupt. Nothing is persisted either — calling the
      // agent off is a control gesture, not something said to it. When a turn
      // was actually running, its own closing note is the answer, so the bot
      // stays quiet rather than saying the same thing twice.
      if (isStopCommand(message)) {
        const stopped = await stopActiveTurn(chatId);
        // Words typed after `/stop` are not a second instruction to run —
        // starting a turn in the same breath as calling one off is the
        // opposite of the request — but they are not dropped in silence
        // either. Everything else here is unchanged: the turn's own closing
        // note is the answer when one was running.
        const ignored = trailingTextNotice(STOP_COMMAND, message);
        const reply = stopped
          ? ignored
          : ignored === null
            ? NOTHING_RUNNING_NOTICE
            : `${NOTHING_RUNNING_NOTICE}\n\n${ignored}`;
        if (reply !== null) {
          await telegramAdapter.sendMessage(chatId, reply).catch((err: unknown) => {
            getLog().warn({ err, chatId }, 'telegram.stop_reply_failed');
          });
        }
        return;
      }

      // Resolve Telegram user id (numeric) → Archon user UUID.
      const userId = await resolveUserId('telegram', telegramUserId, displayName);

      // A Telegram chat holds many conversations (`<chat id>:<n>`); the
      // message belongs to the most recently active one. A lookup failure
      // falls back to the chat's first, legacy-shaped conversation rather
      // than dropping the message.
      let conversationId = chatId;
      try {
        conversationId = await resolveActiveTelegramConversationId(chatId);
      } catch (err) {
        getLog().error({ err, chatId }, 'telegram.active_conversation_lookup_failed');
      }

      // The same conversation may be open in the browser. Mirror each reply
      // onto its web stream so the console updates live instead of waiting
      // for a refetch; the message rows themselves are persisted by the
      // orchestrator, as they are for every non-web platform.
      //
      // The operator's own message is the exception, and it is written just
      // below rather than by the orchestrator — see there for why.
      const mirrored = withOutboundMirror(telegramAdapter, (text, metadata) => {
        void webAdapter
          .emitSSE(
            conversationId,
            JSON.stringify({
              type: 'text',
              content: text,
              isComplete: true,
              timestamp: Date.now(),
              ...(metadata?.category ? { category: metadata.category } : {}),
            })
          )
          .catch((err: unknown) => {
            getLog().warn({ err, conversationId }, 'telegram.web_mirror_failed');
          });
      });

      // The phone's own "agent is working" line, fed by the tool stream the
      // console's trace is built from. Outermost of the chain on purpose: it
      // ADDS `sendStructuredEvent`, which the wrapper inside it would answer
      // for the bare adapter (which has none). The line itself never travels
      // through `sendMessage`, so neither the mirror above nor the history
      // writer inside `handleMessage` can see it — the console draws its own
      // indicator, and this one is chrome rather than something anybody said.
      const turnStatus = createTurnStatus(
        id => telegramAdapter.statusTransport(id),
        conversationId
      );
      const deliverTo = withTurnStatus(mirrored, turnStatus);

      // A voice note is the one message whose wait begins before its turn
      // does: the recording is fetched and recognised HERE, ahead of the
      // conversation lock, and the operator used to watch an empty chat for
      // as long as that took. `voiceDurationSec` is set only for a
      // recording, which makes this the earliest point at which the bot can
      // honestly say what it is busy with.
      if (voiceDurationSec !== undefined) turnStatus?.transcribing();

      // Photos and documents take the same road as a browser upload:
      // validated and written by the shared helper, handed to the agent as
      // `attachedFiles`, and visible in the web console's history afterwards.
      let attachedFiles: AttachedFile[] | undefined;
      // A recording IS the message: what the operator said replaces the
      // caption (which a voice note cannot even have), and the file stays
      // attached beside it. Everything below — the row, the console nudge,
      // the turn — then carries the words rather than the name of an audio
      // file nobody can listen to.
      let turnText = message;
      let persistedUserMessage = false;

      // Everything between here and the lock can end this message early — a
      // refused upload returns, a database lookup can throw — and none of
      // those endings may leave a line on screen saying work is happening.
      // `clear` is idempotent, so the turn's own `finally` further down is
      // free to call it again.
      try {
        if (files !== undefined && files.length > 0) {
          const stored = await persistTelegramFiles(conversationId, files, file =>
            telegramAdapter.downloadFile(file)
          );
          if (!stored.ok) {
            // A refused file is answered, never swallowed — and the line
            // goes before the refusal does, so the operator is not told
            // "Transcribing…" directly above "that file is too large".
            await turnStatus?.clear();
            await telegramAdapter
              .sendMessage(conversationId, stored.error)
              .catch((err: unknown) => {
                getLog().warn({ err, conversationId }, 'telegram.upload_refusal_send_failed');
              });
            return;
          }
          attachedFiles = stored.savedFiles;
        }

        if (attachedFiles !== undefined) {
          const conversation = await conversationDb
            .findConversationByPlatformId(conversationId)
            .catch((err: unknown) => {
              getLog().warn({ err, conversationId }, 'telegram.assistant_lookup_failed');
              return null;
            });
          const dictated = await dictationFor({
            typed: message,
            files: attachedFiles,
            assistantType: conversation?.ai_assistant_type ?? 'claude',
            ...(userId !== undefined ? { userId } : {}),
            ...(voiceDurationSec === undefined ? {} : { durationSec: voiceDurationSec }),
          });
          if (dictated !== null) {
            turnText = dictated.text;
            // The phone's copy of the transcript, hanging off the voice note it
            // came from. The console needs no such echo — it renders the
            // transcript inside the message — and this one is best effort:
            // the words are already persisted and already on their way to the
            // agent, so a failed echo costs a convenience, not the turn.
            if (platformMessageId !== undefined) {
              await telegramAdapter
                .replyToMessage(conversationId, dictated.echo, platformMessageId)
                .catch((err: unknown) => {
                  getLog().warn({ err, conversationId }, 'telegram.transcript_echo_failed');
                });
            }
          }
        }

        // Written HERE, before the lock, not inside the turn.
        //
        // `acquireLock` holds a message that arrives mid-turn in memory — no
        // row, no event, nothing on any screen — until the running turn ends
        // and the queued handler finally starts. A line typed at 13:35 could
        // surface in the console at 13:41. Persisting at ingest makes it
        // visible the moment it lands, and stamps it with the time Telegram
        // says it was sent rather than the time we got around to inserting it,
        // so it also sits in the right place among the bubbles it arrived
        // between. The orchestrator is told not to write a second one.
        persistedUserMessage = await persistInboundMessage({
          platformType: 'telegram',
          platformConversationId: conversationId,
          text: turnText,
          ...(userId !== undefined ? { userId } : {}),
          ...(sentAtMs !== undefined ? { sentAtMs } : {}),
          ...(attachedFiles !== undefined && attachedFiles.length > 0
            ? {
                // Shaped as the browser upload route writes it. The on-disk
                // path is left out on purpose: the file is deleted once the
                // agent has read it, and a stale path in the history would
                // only mislead whoever reads it next.
                metadata: {
                  files: attachedFiles.map(f => ({
                    name: f.name,
                    mimeType: f.mimeType,
                    size: f.size,
                  })),
                },
              }
            : {}),
        });
        // The console may be watching this conversation; nudge it rather than
        // leaving the message to the next poll.
        await webAdapter
          .emitSSE(
            conversationId,
            JSON.stringify({ type: 'user_message', content: turnText, timestamp: Date.now() })
          )
          .catch((err: unknown) => {
            getLog().warn({ err, conversationId }, 'telegram.inbound_mirror_failed');
          });
      } catch (err) {
        await turnStatus?.clear();
        throw err;
      }

      // The words are ready, but this chat may still be busy with the
      // message before it. Saying "Thinking…" now would be untrue and
      // leaving "Transcribing…" up would be stale, so the line says what is
      // actually happening until `begin` replaces it. Nothing to do for a
      // typed message: `queued` will not open a line that is not already up.
      if (isTurnRunning(conversationId)) turnStatus?.queued();

      // Fire-and-forget: handler returns immediately, processing happens async
      lockManager
        .acquireLock(conversationId, async () => {
          // Posted the moment the turn starts, before anything has been
          // called: the silence being fixed here starts at "send", not at
          // the first tool. A turn that answers in seconds shows it briefly
          // and then removes it, which is what was asked for.
          turnStatus?.begin();
          try {
            await handleMessage(deliverTo, conversationId, turnText, {
              isolationHints: { workflowType: 'thread', workflowId: conversationId },
              actor: userId ? { kind: 'user', userId } : { kind: 'unidentified' },
              userMessagePersisted: persistedUserMessage,
              ...(attachedFiles !== undefined ? { attachedFiles } : {}),
            });
          } finally {
            // Before the file cleanup, and in `finally` so it covers all
            // three endings: an answer, a failure, and an operator pressing
            // ⏹ Stop. A stopped turn that left "Running tests…" on screen
            // forever is exactly the failure this must not have.
            await turnStatus?.clear();
            // Clean up inside the lock, after the agent has read them —
            // mirrors what the web message route does. Only the files: the
            // conversation's upload directory is shared with uploads that have
            // not written their first file yet.
            if (attachedFiles !== undefined) {
              for (const file of attachedFiles) {
                await unlink(file.path).catch((err: NodeJS.ErrnoException) => {
                  if (err.code !== 'ENOENT') {
                    getLog().warn({ err, filePath: file.path }, 'telegram.upload_cleanup_failed');
                  }
                });
              }
            }
          }
        })
        .catch(async (err: unknown) => {
          // The lock itself refused or broke, so the turn's own `finally`
          // never ran: the line would otherwise outlive the message it was
          // put up for. Idempotent, so this costs nothing when it already did.
          await turnStatus?.clear();
          return createMessageErrorHandler('Telegram', telegramAdapter, conversationId)(err);
        });
    }
  );

  // Who may drive the agent from here (ADR 0004). Set before start(), which
  // refuses without it: a bot that cannot tell a linked account from a
  // stranger does not poll.
  telegramAdapter.setAuthorizer(telegramAccess());
}
