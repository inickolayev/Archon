/**
 * Telegram platform adapter using grammY SDK
 * Handles message sending with 4096 character limit splitting
 */
import { Bot, Context } from 'grammy';
import {
  ADVERTISED_COMMANDS,
  telegramChatIdOf,
  type IPlatformAdapter,
  type MenuKeyboard,
  type MessageMetadata,
} from '@archon/core';
import { formatQuotedMessage, type MessageQuote } from '@archon/core/messaging/quoted-context';
import { createLogger } from '@archon/paths';
import { parseAllowedUserIds, isUserAuthorized } from './auth';
import {
  defaultCaption,
  filesOf,
  unsupportedKindOf,
  unsupportedMessage,
  type TelegramIncomingFile,
  type TelegramMessageLike,
} from './attachments';
import { MediaGroupCollector } from './media-group';
import {
  FORWARDED_WITHOUT_INSTRUCTION,
  batchedForward,
  forwardQuoteOf,
  replyQuoteOf,
  type ForwardedPiece,
  type QuotableMessage,
} from './quotes';
import { convertToTelegramMarkdown, stripMarkdown } from './markdown';
import { sendReferencedImages } from './outbound-images';
import { splitIntoParagraphChunks } from '../../utils/message-splitting';
import type { TelegramMessageContext } from './types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.telegram');
  return cachedLog;
}

const MAX_LENGTH = 4096;
/**
 * Categories the web console renders as structure rather than as something
 * somebody reads — a tool call row, the isolation banner. Telegram has no
 * structure to put them in, so they would arrive as chat messages full of
 * absolute host paths. The same set the browser→Telegram mirror refuses.
 */
const STRUCTURAL_CATEGORIES = new Set(['tool_call_formatted', 'isolation_context']);

/** True for a message that belongs to the console's structure, not to a chat. */
export function isStructuralCategory(category: string | undefined): boolean {
  return category !== undefined && STRUCTURAL_CATEGORIES.has(category);
}
/**
 * How long an album's parts are collected before the whole set is dispatched
 * as one message. Telegram sends them milliseconds apart; this only ever
 * delays a multi-file send.
 */
const MEDIA_GROUP_WAIT_MS = 1200;
/** The Bot API refuses to hand over a file larger than this via getFile. */
const TELEGRAM_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

/** What a tapped button asks the server to do, and what it answers with. */
export interface TelegramCallbackRequest {
  /** Raw `callback_data` — untrusted, validated by the handler. */
  readonly data: string;
  /** The chat the tap came from (from the update, never from the data). */
  readonly chatId: string;
  readonly userId: number | undefined;
}

export interface TelegramCallbackResponse {
  readonly text: string;
  readonly keyboard?: MenuKeyboard;
  /** Short confirmation shown on the button itself. */
  readonly toast?: string;
}

/**
 * Which directories a conversation's answers may show pictures from.
 *
 * Injected rather than computed here: the roots are the conversation's working
 * directory and its project, which live in the database, and this package knows
 * nothing about either. Left unset — as it is for a bare adapter in a test or a
 * tool — no reply carries an image, which is the behaviour before this existed.
 */
export type ImageRootsResolver = (conversationId: string) => Promise<readonly string[]>;

/** Everything about an inbound message except the words it carried. */
type InboundOrigin = Omit<TelegramMessageContext, 'message'>;

/** What an album's first part told us, held until the rest of it lands. */
interface PendingGroupOrigin {
  readonly origin: InboundOrigin;
  readonly quotes: readonly MessageQuote[];
}

/** The pieces of an inbound message the quoting code reads. */
type InboundMessage = TelegramMessageLike & QuotableMessage;

/** Telegram's markup for a keyboard, or nothing when there are no buttons. */
function toReplyMarkup(keyboard: MenuKeyboard | undefined): Record<string, unknown> | undefined {
  if (keyboard === undefined) return undefined;
  if (keyboard.inline !== undefined && keyboard.inline.length > 0) {
    return {
      inline_keyboard: keyboard.inline.map(row =>
        row.map(button => ({ text: button.label, callback_data: button.action }))
      ),
    };
  }
  if (keyboard.persistent !== undefined && keyboard.persistent.length > 0) {
    return {
      keyboard: keyboard.persistent.map(row => row.map(label => ({ text: label }))),
      resize_keyboard: true,
      is_persistent: true,
    };
  }
  return undefined;
}

export class TelegramAdapter implements IPlatformAdapter {
  private bot: Bot;
  private streamingMode: 'stream' | 'batch';
  private allowedUserIds: number[];
  private messageHandler: ((ctx: TelegramMessageContext) => Promise<void>) | null = null;
  private callbackHandler:
    | ((request: TelegramCallbackRequest) => Promise<TelegramCallbackResponse | null>)
    | null = null;
  /** Kept only to build the file-download URL; never logged, never sent. */
  readonly #token: string;
  readonly #mediaGroups: MediaGroupCollector<TelegramIncomingFile>;
  /**
   * Album parts carry no chat/sender of their own once collected — and no reply
   * either, since only the first part of an album can point at anything.
   */
  readonly #mediaGroupOrigins = new Map<string, PendingGroupOrigin>();
  /**
   * Forwards arriving back-to-back, buffered per chat.
   *
   * Forwarding four messages is one gesture. Telegram delivers it as four
   * updates with nothing tying them together — no `media_group_id` unless they
   * happen to be one album — so the only thing they share is the chat and the
   * moment. Same collector, same wait, keyed by the chat instead.
   */
  readonly #forwards: MediaGroupCollector<ForwardedPiece<TelegramIncomingFile>>;
  readonly #forwardOrigins = new Map<string, InboundOrigin>();
  #imageRoots: ImageRootsResolver | null = null;

  constructor(token: string, mode: 'stream' | 'batch' = 'stream', mediaGroupWaitMs?: number) {
    this.#token = token;
    this.#mediaGroups = new MediaGroupCollector<TelegramIncomingFile>(
      mediaGroupWaitMs ?? MEDIA_GROUP_WAIT_MS,
      (groupId, group) => {
        // The chat and sender were stashed when the group's first part arrived.
        const pending = this.#mediaGroupOrigins.get(groupId);
        this.#mediaGroupOrigins.delete(groupId);
        if (pending === undefined || group.items.length === 0) return;
        const caption = group.caption?.trim();
        const body = caption && caption.length > 0 ? caption : defaultCaption(group.items);
        this.#dispatch({
          ...pending.origin,
          message: formatQuotedMessage(pending.quotes, body),
          files: [...group.items],
        });
      }
    );
    this.#forwards = new MediaGroupCollector<ForwardedPiece<TelegramIncomingFile>>(
      mediaGroupWaitMs ?? MEDIA_GROUP_WAIT_MS,
      (chatId, group) => {
        const origin = this.#forwardOrigins.get(chatId);
        this.#forwardOrigins.delete(chatId);
        if (origin === undefined || group.items.length === 0) return;
        const { quotes, files } = batchedForward(group.items);
        this.#dispatch({
          ...origin,
          // Nothing the operator wrote: Telegram gives no way to add words to a
          // forward. The agent is told that, rather than handed an empty turn.
          message: formatQuotedMessage(quotes, FORWARDED_WITHOUT_INSTRUCTION),
          ...(files.length > 0 ? { files } : {}),
        });
      }
    );
    // grammY does not impose a handler timeout by default (unlike Telegraf's 90s limit)
    this.bot = new Bot(token);
    this.streamingMode = mode;

    // Parse Telegram user whitelist (optional - empty = open access)
    // Support both TELEGRAM_ALLOWED_USER_IDS and TELEGRAM_ALLOWED_USERS
    this.allowedUserIds = parseAllowedUserIds(
      process.env.TELEGRAM_ALLOWED_USER_IDS ?? process.env.TELEGRAM_ALLOWED_USERS
    );
    if (this.allowedUserIds.length > 0) {
      getLog().info({ userCount: this.allowedUserIds.length }, 'telegram.whitelist_enabled');
    } else {
      // Not fatal here — `start()` is what refuses, so constructing an adapter
      // (tests, tooling) stays possible.
      getLog().warn('telegram.whitelist_missing');
    }

    getLog().info({ mode }, 'telegram.adapter_initialized');
  }

  /**
   * Send a message to a Telegram chat
   * Automatically splits messages longer than 4096 characters
   *
   * Formatting strategy:
   * - Short messages (≤4096 chars): Convert to MarkdownV2 for nice formatting
   * - Long messages: Split by paragraphs, format each chunk independently
   *   (paragraphs rarely have formatting that spans across them)
   */
  async sendMessage(
    conversationId: string,
    message: string,
    metadata?: MessageMetadata
  ): Promise<void> {
    if (isStructuralCategory(metadata?.category)) {
      // Not this window's business. The web UI draws these as structure — a
      // tool row that folds away — and the mirror already refuses to forward
      // them. On a phone the same thing is a wall of `✏️READ Reading:
      // /Users/…/artifacts/uploads/…jpg`: noise, and host paths in a chat.
      getLog().debug(
        { conversationId, category: metadata?.category },
        'telegram.structural_message_skipped'
      );
      return;
    }
    // A conversation id is `<chat id>[:<n>]` — many Archon conversations share
    // one Telegram chat. Parse the chat id out explicitly rather than leaning on
    // `parseInt` stopping at the colon by accident.
    const id = telegramChatIdOf(conversationId);
    getLog().debug(
      { conversationId, chatId: id, messageLength: message.length },
      'telegram.send_message'
    );

    // Buttons ride on the LAST chunk: a keyboard belongs under the end of what
    // it refers to, not in the middle of a split answer.
    const markup = toReplyMarkup(metadata?.keyboard);

    if (message.length <= MAX_LENGTH) {
      // Short message: try MarkdownV2 formatting
      await this.sendFormattedChunk(id, message, markup);
    } else {
      // Long message: split by paragraphs, format each chunk
      getLog().debug({ messageLength: message.length }, 'telegram.message_splitting');
      const chunks = splitIntoParagraphChunks(message, MAX_LENGTH - 200);

      for (const [index, chunk] of chunks.entries()) {
        await this.sendFormattedChunk(id, chunk, index === chunks.length - 1 ? markup : undefined);
      }
    }

    // After the whole text, never between its chunks: a picture belongs under
    // the sentence that introduced it.
    await this.#sendReferencedImages(id, conversationId, message);
  }

  /**
   * Upload the pictures this message names, if any and if the install has said
   * which directories this conversation may show.
   *
   * The text is parsed as it was delivered. A streamed answer arrives one block
   * at a time, so a path is only found when it sits whole inside one block —
   * true for every provider that emits text a block at a time, and a missed
   * reference costs the picture, not the answer.
   */
  async #sendReferencedImages(
    chatId: number,
    conversationId: string,
    message: string
  ): Promise<void> {
    const resolver = this.#imageRoots;
    if (resolver === null) return;
    let roots: readonly string[];
    try {
      roots = await resolver(conversationId);
    } catch (err) {
      getLog().warn({ err, conversationId }, 'telegram.image_roots_unresolved');
      return;
    }
    await sendReferencedImages(this.bot.api, chatId, message, roots);
  }

  /**
   * Say which directories this bot's replies may show pictures from. Without it
   * every reply is text only.
   */
  onImageRoots(resolver: ImageRootsResolver): void {
    this.#imageRoots = resolver;
  }

  /**
   * Send a single chunk with MarkdownV2 formatting, with fallback to plain text
   */
  private async sendFormattedChunk(
    id: number,
    chunk: string,
    markup?: Record<string, unknown>
  ): Promise<void> {
    // If chunk is still too long after paragraph splitting, fall back to plain text
    if (chunk.length > MAX_LENGTH) {
      getLog().debug({ chunkLength: chunk.length }, 'telegram.chunk_too_long_plain_text');
      const plainText = stripMarkdown(chunk);
      // Split by lines if still too long
      const lines = plainText.split('\n');
      let subChunk = '';
      for (const line of lines) {
        if (subChunk.length + line.length + 1 > MAX_LENGTH - 100) {
          if (subChunk) await this.bot.api.sendMessage(id, subChunk);
          subChunk = line;
        } else {
          subChunk += (subChunk ? '\n' : '') + line;
        }
      }
      if (subChunk) await this.bot.api.sendMessage(id, subChunk);
      return;
    }

    // Try MarkdownV2 formatting
    const formatted = convertToTelegramMarkdown(chunk);
    try {
      await this.bot.api.sendMessage(id, formatted, {
        parse_mode: 'MarkdownV2',
        ...(markup ? { reply_markup: markup as never } : {}),
      });
      getLog().debug({ chunkLength: chunk.length }, 'telegram.markdownv2_chunk_sent');
    } catch (error) {
      // Fallback to stripped plain text for this chunk
      const err = error as Error;
      getLog().warn(
        {
          err,
          originalPreview: chunk.substring(0, 200),
          formattedPreview: formatted.substring(0, 200),
        },
        'telegram.markdownv2_failed'
      );
      // Keep the call shape identical when there are no buttons — a bare
      // (id, text) plain-text fallback, exactly as before.
      if (markup) {
        await this.bot.api.sendMessage(id, stripMarkdown(chunk), {
          reply_markup: markup as never,
        });
      } else {
        await this.bot.api.sendMessage(id, stripMarkdown(chunk));
      }
    }
  }

  /**
   * Get the grammY bot instance
   */
  getBot(): Bot {
    return this.bot;
  }

  /**
   * Get the configured streaming mode
   */
  getStreamingMode(): 'stream' | 'batch' {
    return this.streamingMode;
  }

  /**
   * Get platform type
   */
  getPlatformType(): string {
    return 'telegram';
  }

  /**
   * Extract conversation ID from Telegram context
   */
  getConversationId(ctx: Context): string {
    if (!ctx.chat) {
      throw new Error('No chat in context');
    }
    return ctx.chat.id.toString();
  }

  /**
   * Ensure responses go to a thread.
   * Telegram doesn't have threads - each chat is a persistent conversation.
   * Returns original conversation ID unchanged.
   */
  async ensureThread(originalConversationId: string, _messageContext?: unknown): Promise<string> {
    return originalConversationId;
  }

  /**
   * The authorized chat + sender behind an update, or null when the sender is
   * not on the whitelist (rejected silently, as before).
   */
  #originOf(ctx: Context): InboundOrigin | null {
    const userId = ctx.from?.id;
    if (!isUserAuthorized(userId, this.allowedUserIds)) {
      // Log unauthorized attempt (mask user ID for privacy)
      const maskedId = userId !== undefined ? `${String(userId).slice(0, 4)}***` : 'unknown';
      getLog().info({ maskedUserId: maskedId }, 'telegram.unauthorized_message');
      return null;
    }
    // Derive a Telegram display name from inbound payload — no extra API call needed.
    const from = ctx.from;
    const fullName =
      from?.first_name || from?.last_name
        ? [from.first_name, from.last_name].filter(Boolean).join(' ')
        : undefined;
    return {
      conversationId: this.getConversationId(ctx),
      userId,
      displayName: fullName ?? from?.username ?? undefined,
    };
  }

  /** Hand one inbound message to the server, if it has registered a handler. */
  #dispatch(context: TelegramMessageContext): void {
    if (!this.messageHandler) {
      // Intentional: message dropped silently if handler not registered yet.
      // In production the server always calls onMessage() before start(); this
      // path only surfaces during development or misconfiguration.
      getLog().debug(
        { conversationId: context.conversationId },
        'telegram.message_dropped_no_handler'
      );
      return;
    }
    // Fire-and-forget - errors handled by caller
    void this.messageHandler(context);
  }

  /**
   * Hand over one inbound message together with whatever it pointed at.
   *
   * A forward goes into the per-chat buffer instead of straight out, because
   * the next one is probably a millisecond away. Anything else — including a
   * reply — leaves immediately, with the quote written into the text so both
   * windows and the agent read the same thing.
   */
  #dispatchQuoted(
    origin: InboundOrigin,
    message: InboundMessage,
    body: string,
    files: readonly TelegramIncomingFile[]
  ): void {
    const forwarded = forwardQuoteOf(message);
    if (forwarded !== null) {
      this.#forwardOrigins.set(origin.conversationId, origin);
      this.#forwards.add(origin.conversationId, { items: [{ quote: forwarded, files }] });
      return;
    }
    const replied = replyQuoteOf(message, origin.userId);
    this.#dispatch({
      ...origin,
      message: formatQuotedMessage(replied === null ? [] : [replied], body),
      ...(files.length > 0 ? { files: [...files] } : {}),
    });
  }

  /**
   * Download one file's bytes. The URL carries the bot token, so failures are
   * re-thrown without it: nothing here may reach a log or a chat message.
   */
  async downloadFile(file: TelegramIncomingFile): Promise<Uint8Array> {
    if (file.size !== undefined && file.size > TELEGRAM_DOWNLOAD_LIMIT_BYTES) {
      throw new Error('That file is larger than the 20 MB the Telegram Bot API can hand over.');
    }
    let path: string | undefined;
    try {
      const described = await this.bot.api.getFile(file.fileId);
      path = described.file_path;
    } catch {
      throw new Error('Telegram would not hand over that file.');
    }
    if (path === undefined || path === '') {
      throw new Error('Telegram returned no download path for that file.');
    }
    const response = await fetch(`https://api.telegram.org/file/bot${this.#token}/${path}`).catch(
      () => null
    );
    if (!response?.ok) {
      throw new Error('Downloading that file from Telegram failed.');
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * Register a message handler for incoming messages
   * Must be called before start()
   */
  onMessage(handler: (ctx: TelegramMessageContext) => Promise<void>): void {
    this.messageHandler = handler;
  }

  /**
   * Register the handler for tapped buttons. Must be called before start().
   */
  onCallback(
    handler: (request: TelegramCallbackRequest) => Promise<TelegramCallbackResponse | null>
  ): void {
    this.callbackHandler = handler;
  }

  /**
   * Start the bot (begins polling).
   * Makes up to 3 attempts on 409 Conflict (stale getUpdates connection).
   */
  async start(options?: { retryDelayMs?: number }): Promise<void> {
    // An unconfigured whitelist is refused, not treated as open access: this bot
    // reaches an agent that can write to a real checkout, so "anyone who finds
    // the bot" is never an acceptable audience. Upstream's default is the
    // opposite; see docs/adr/0001-telegram-as-second-front-end.md in the Factory.
    if (this.allowedUserIds.length === 0) {
      getLog().error(
        { envVar: 'TELEGRAM_ALLOWED_USER_IDS' },
        'telegram.refusing_to_start_open_bot'
      );
      throw new Error(
        'Refusing to start the Telegram bot: TELEGRAM_ALLOWED_USER_IDS is empty, which would let any Telegram user drive an agent with write access. Set it to the comma-separated numeric ids allowed to use this bot.'
      );
    }

    // Register message handler before launch
    this.bot.on('message:text', ctx => {
      const text = ctx.message.text;
      if (!text) return;
      const origin = this.#originOf(ctx);
      if (origin === null) return;
      this.#dispatchQuoted(origin, ctx.message as unknown as InboundMessage, text, []);
    });

    // Photos and documents. Everything the agent can actually read goes through
    // the same path as a browser upload: the server downloads, validates and
    // persists them; this only says what and where.
    this.bot.on(['message:photo', 'message:document'], ctx => {
      const origin = this.#originOf(ctx);
      if (origin === null) return;
      const message = ctx.message as unknown as InboundMessage;
      const files = filesOf(message);
      if (files.length === 0) return;
      const caption = message.caption?.trim();
      const body = caption && caption.length > 0 ? caption : defaultCaption(files);

      // A forwarded album is a batch of forwards, not an album of its own: it
      // goes to the per-chat buffer below, which already folds repeats of one
      // origin together. Only an album the operator sent themselves lands here.
      const groupId = message.forward_origin === undefined ? message.media_group_id : undefined;
      if (groupId !== undefined && groupId !== '') {
        // An album arrives as several updates; collect them into one message
        // instead of starting a turn per photo. Only its first part can be a
        // reply, so the quote is taken there and later parts do not erase it.
        if (!this.#mediaGroupOrigins.has(groupId)) {
          const replied = replyQuoteOf(message, origin.userId);
          this.#mediaGroupOrigins.set(groupId, {
            origin,
            quotes: replied === null ? [] : [replied],
          });
        }
        this.#mediaGroups.add(groupId, { caption, items: files });
        return;
      }

      this.#dispatchQuoted(origin, message, body, files);
    });

    // Media the agent cannot read. Silence was the old behaviour and it looked
    // like the bot was broken — say so in one line instead.
    this.bot.on(
      [
        'message:voice',
        'message:video_note',
        'message:sticker',
        'message:audio',
        'message:video',
        'message:animation',
      ],
      ctx => {
        const userId = ctx.from?.id;
        if (!isUserAuthorized(userId, this.allowedUserIds)) return;
        const kind = unsupportedKindOf(ctx.message as unknown as TelegramMessageLike);
        if (kind === null) return;
        void ctx.reply(unsupportedMessage(kind)).catch((err: unknown) => {
          getLog().warn({ err }, 'telegram.unsupported_media_reply_failed');
        });
      }
    );

    // Tapped buttons. The whitelist applies here exactly as it does to
    // messages — otherwise the keyboards would be a way straight past it — and
    // the query is ALWAYS answered, or the client spins forever.
    this.bot.on('callback_query:data', ctx => {
      const userId = ctx.from.id;
      const data = ctx.callbackQuery.data;
      const chatId = ctx.chat?.id;

      void (async (): Promise<void> => {
        try {
          if (!isUserAuthorized(userId, this.allowedUserIds)) {
            const maskedId = `${String(userId).slice(0, 4)}***`;
            getLog().info({ maskedUserId: maskedId }, 'telegram.unauthorized_callback');
            await ctx.answerCallbackQuery();
            return;
          }
          if (this.callbackHandler === null || chatId === undefined) {
            await ctx.answerCallbackQuery();
            return;
          }

          const reply = await this.callbackHandler({
            data,
            chatId: String(chatId),
            userId,
          });
          if (reply === null) {
            // Unknown or stale token — say so on the button, change nothing.
            await ctx.answerCallbackQuery({ text: 'That button is no longer valid' });
            return;
          }

          // Edit in place: the list the operator is looking at is the one that
          // should change, instead of a new message every tap.
          await ctx
            .editMessageText(reply.text, {
              ...(toReplyMarkup(reply.keyboard)
                ? { reply_markup: toReplyMarkup(reply.keyboard) as never }
                : {}),
            })
            .catch((err: unknown) => {
              // 'message is not modified' is normal when nothing changed.
              getLog().debug({ err }, 'telegram.callback_edit_skipped');
            });
          await ctx.answerCallbackQuery(reply.toast ? { text: reply.toast } : undefined);
        } catch (err) {
          getLog().warn({ err }, 'telegram.callback_failed');
          await ctx.answerCallbackQuery({ text: 'Something went wrong' }).catch(() => undefined);
        }
      })();
    });

    // Retry on 409 Conflict — another getUpdates is still active (Telegram's long-poll timeout is 50s).
    // Wait 60s between attempts to outlast the stale connection. Do NOT recreate the bot instance
    // on each retry — that adds more stale connections rather than fewer.
    const MAX_ATTEMPTS = 3;
    const RETRY_DELAY_MS = options?.retryDelayMs ?? 60_000;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // drop_pending_updates: true — discard queued messages from while the bot was offline
        // to avoid reprocessing stale commands after a container restart.
        // grammY's start() resolves only when the bot stops; use onStart callback to detect
        // successful launch and return immediately while the bot continues running in background.
        await new Promise<void>((resolve, reject) => {
          this.bot
            .start({
              drop_pending_updates: true,
              onStart: () => {
                resolve();
              },
            })
            .catch((err: unknown) => {
              const error = err instanceof Error ? err : new Error(String(err));
              // Log post-startup crashes — after onStart fires the reject() below is a no-op
              // (Promise already settled), but the error should still be observable in logs.
              getLog().error({ err: error }, 'telegram.bot_runtime_error');
              reject(error);
            });
        });
        getLog().info('telegram.bot_started');
        // Advertise only the few commands worth typing; everything else is a
        // button. Failing to publish them must not fail the bot.
        await this.bot.api.setMyCommands([...ADVERTISED_COMMANDS]).catch((err: unknown) => {
          getLog().warn({ err }, 'telegram.set_my_commands_failed');
        });
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const is409 = message.includes('409');
        if (is409 && attempt < MAX_ATTEMPTS) {
          getLog().warn(
            { err, attempt, maxAttempts: MAX_ATTEMPTS, retryDelayMs: RETRY_DELAY_MS },
            'telegram.start_conflict_retrying'
          );
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        } else {
          throw err instanceof Error ? err : new Error(message);
        }
      }
    }
  }

  /**
   * Stop the bot gracefully
   */
  stop(): void {
    this.bot.stop();
    getLog().info('telegram.bot_stopped');
  }
}
