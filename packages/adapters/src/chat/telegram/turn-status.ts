/**
 * The "agent is working" line, on a phone.
 *
 * The console has shown one since it had a chat: a spinner, the latest tool,
 * and a trace to expand. Telegram showed nothing at all — the operator sent a
 * message and watched an empty chat until the answer landed, which on a long
 * turn is minutes of not knowing whether the bot had even received it.
 *
 * A chat app has no chrome to put an indicator in, so the indicator has to be a
 * message. That makes it the one message in the conversation that is NOT part
 * of the conversation: it is posted the moment the turn starts, rewritten in
 * place as the work moves on, and deleted when the turn is over. It is sent
 * straight down the Bot API through `StatusTransport` rather than through
 * `sendMessage`, which is what keeps it out of the history and off the web
 * console's mirror — both of those wrap `IPlatformAdapter.sendMessage`, and
 * neither can see something that never goes through it. The console draws its
 * own indicator; a mirrored copy of this one would be the same thing twice.
 *
 * Two Telegram facts shape everything below. Edits are rate-limited, so the
 * text is throttled rather than written per tool call. And an edit whose text
 * is unchanged is answered with `400 message is not modified`, so identical
 * text is never sent — both of those are ordinary outcomes here, not errors,
 * and NOTHING in this file is allowed to fail the turn it is decorating.
 */

import { createLogger } from '@archon/paths';
import {
  STATUS_FINISHED,
  STATUS_QUEUED,
  STATUS_THINKING,
  STATUS_TRANSCRIBING,
} from './turn-status-text';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('telegram.turn-status');
  return cachedLog;
}

/**
 * The four Bot API calls this needs, and nothing else.
 *
 * A port rather than the grammY `Api` itself: the lifecycle below — when to
 * write, when to keep quiet, what happens when a delete is refused — is the
 * part worth testing, and it should be testable without a bot token. The
 * implementation (in the adapter) is what owns the HTTP failures; by contract
 * NONE of these throw.
 */
export interface StatusTransport {
  /** Post the line. Returns the message id, or null when Telegram refused. */
  send(text: string): Promise<number | null>;
  /** Rewrite the line in place. Silent about failure, including "not modified". */
  edit(messageId: number, text: string): Promise<void>;
  /** Take the line away. False when Telegram would not, so a fallback can run. */
  remove(messageId: number): Promise<boolean>;
  /** The cheap complement: the "typing…" bubble, which expires on its own. */
  typing(): Promise<void>;
}

export interface TurnStatusOptions {
  /** Shortest gap between two edits of the line. */
  readonly throttleMs: number;
}

/**
 * One turn's status line.
 *
 * Single-use by construction: `begin` once, `step` as often as the turn likes,
 * `clear` once, and the instance is spent. A turn that ends and a turn that
 * starts are different objects, so a late event from the old turn can never
 * rewrite the new turn's line.
 */
export class TurnStatus {
  readonly #transport: StatusTransport;
  readonly #throttleMs: number;

  /**
   * Every call that touches Telegram queues here.
   *
   * The ordering this buys is not a nicety. A turn can end in the same breath
   * as it begins — the operator's correction to the brief made that the normal
   * case, not the edge one — and a delete that raced its own send would either
   * fire against an id that did not exist yet or leave the message behind
   * forever. Queued, the delete simply runs after the send and knows the id.
   */
  #tail: Promise<void> = Promise.resolve();

  /** The line's message id once Telegram has given us one. */
  #messageId: number | null = null;
  /** The text last handed to Telegram — what the operator is looking at. */
  #written: string | null = null;
  /** The text we want shown; equal to `#written` once things go quiet. */
  #wanted: string | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #lastWriteAt = 0;
  /** Set by `clear`. Nothing is written afterwards, ever. */
  #over = false;

  constructor(transport: StatusTransport, options: TurnStatusOptions) {
    this.#transport = transport;
    this.#throttleMs = options.throttleMs;
  }

  /**
   * Put the line up for the first time. Later calls do nothing: ONE message per
   * turn, whichever state happened to open it.
   *
   * Returns at once — nothing may wait on a Telegram round trip.
   */
  #open(text: string): void {
    if (this.#over || this.#wanted !== null) return;
    this.#wanted = text;
    this.#lastWriteAt = Date.now();
    this.#enqueue(() => this.#write());
  }

  /**
   * A voice note is being turned into words.
   *
   * Opens the line BEFORE the turn exists, because transcription does too: it
   * runs at ingest, ahead of the conversation lock. Handed over to the states
   * below by `begin` editing the same message rather than posting a second one.
   */
  transcribing(): void {
    this.#open(STATUS_TRANSCRIBING);
  }

  /**
   * The message is ready but something else is running in this chat.
   *
   * Deliberately will NOT open a line that is not already up. It exists to keep
   * a transcription line honest while it waits, not to announce every queued
   * message — a typed message that queues behaves exactly as it always has,
   * and its line starts at `begin` when its turn finally runs.
   */
  queued(): void {
    if (this.#wanted === null) return;
    this.step(STATUS_QUEUED);
  }

  /**
   * The turn has started: the agent is thinking.
   *
   * No delay before the first send, deliberately. An earlier draft waited a
   * couple of seconds so a fast turn would never flash a status message; the
   * operator asked for the opposite, because what is being fixed is the
   * silence after pressing send — "даже если думает, мы сразу прислали ответ,
   * что думает". A turn that answers in two seconds therefore shows the line
   * briefly and then removes it, which is the intended behaviour and not a
   * defect. (A turn that ends before the send has even left is quieter still:
   * `#write` checks `#over` when it runs, so nothing is posted at all.)
   *
   * When a line is already up — a dictated message — this is a rewrite of it
   * rather than a second message, and it goes through the throttle like any
   * other step, which is also what keeps the handover from flickering.
   */
  begin(): void {
    if (this.#wanted === null) {
      this.#open(STATUS_THINKING);
      return;
    }
    this.step(STATUS_THINKING);
  }

  /**
   * Say that the work has moved on.
   *
   * Cheap to call per tool: identical text is dropped here, and anything else
   * waits for the throttle rather than becoming an edit of its own. Only the
   * LATEST text is ever written — a burst of five tool calls inside one
   * interval costs one edit showing the fifth, not five edits ending there.
   */
  step(text: string): void {
    if (this.#over || text === this.#wanted) return;
    this.#wanted = text;
    this.#schedule();
  }

  /**
   * The turn is over: take the line away.
   *
   * Called from the turn's `finally`, so it covers all three endings — an
   * answer delivered, a failure reported, and an operator pressing ⏹ Stop. A
   * stopped turn leaving "Running tests…" on screen forever is exactly the
   * failure this feature must not have, and the only way to be sure of that is
   * to clear it where the turn ends rather than where it succeeds.
   *
   * Awaited by the caller so the line is gone before the chat goes quiet, but
   * it cannot fail: every transport call swallows its own errors.
   */
  async clear(): Promise<void> {
    if (this.#over) return;
    this.#over = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#enqueue(async () => {
      const messageId = this.#messageId;
      this.#messageId = null;
      if (messageId === null) return;
      const removed = await this.#transport.remove(messageId);
      // Deleting is what the operator asked for; editing is what is left when
      // Telegram will not (past 48 hours, or somebody deleted it by hand).
      if (!removed) await this.#transport.edit(messageId, STATUS_FINISHED);
    });
    await this.#tail;
  }

  /** Arrange for the wanted text to be written, no sooner than the throttle allows. */
  #schedule(): void {
    if (this.#timer !== null) return;
    const delay = Math.max(0, this.#throttleMs - (Date.now() - this.#lastWriteAt));
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#enqueue(() => this.#write());
    }, delay);
    // A pending status edit is never a reason to keep the process alive.
    this.#timer.unref?.();
  }

  async #write(): Promise<void> {
    const text = this.#wanted;
    if (this.#over || text === null || text === this.#written) return;
    this.#lastWriteAt = Date.now();
    if (this.#messageId === null) {
      // No line yet — either this is the first write, or the first send was
      // refused and this is the next chance to post one. Not a re-send: there
      // is nothing on screen to edit.
      const messageId = await this.#transport.send(text);
      if (messageId === null) return;
      this.#messageId = messageId;
    } else {
      await this.#transport.edit(this.#messageId, text);
    }
    // Marked written even when the edit failed: the transport has already
    // logged it, and the alternative is retrying the same text against a
    // Telegram that just refused it. The next real step corrects the screen.
    this.#written = text;
    await this.#transport.typing();
  }

  #enqueue(job: () => Promise<void>): void {
    this.#tail = this.#tail.then(async () => {
      try {
        await job();
      } catch (err) {
        // Belt and braces — the transport already swallows its own failures.
        // A status line is decoration; it may not cost the operator a turn.
        getLog().debug({ err }, 'telegram.turn_status_failed');
      }
    });
  }
}
