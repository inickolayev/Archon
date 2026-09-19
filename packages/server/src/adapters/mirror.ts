/**
 * Delivering one reply to every platform a conversation is visible in.
 *
 * A conversation is born on one platform but is not owned by it: a question
 * typed in the browser inside a Telegram-born chat must also reach the phone,
 * and a reply produced from Telegram must reach an open browser. The
 * orchestrator only knows one adapter, so the mirroring happens here, around
 * the adapter it is handed.
 *
 * The wrapper is a Proxy rather than a hand-written implementation of
 * `IPlatformAdapter`: the orchestrator calls optional, platform-specific
 * members on the web adapter (structured events, lock events), and forwarding
 * everything by construction is the only version of this that cannot silently
 * lose one of them.
 */

import type { IPlatformAdapter, MessageMetadata } from '@archon/core';

/** What a mirrored copy of one outbound message looks like before delivery. */
export interface MirroredMessage {
  readonly category?: string;
  readonly text: string;
}

/**
 * Categories the web UI renders structurally rather than as chat text. Sending
 * them to a phone would be noise, not information.
 */
const STRUCTURAL_CATEGORIES = new Set(['tool_call_formatted', 'isolation_context']);

/**
 * Collects what the orchestrator sends while a turn runs, so the mirror
 * delivers whole messages instead of a burst of stream chunks.
 *
 * Streaming sends assistant text one delta at a time (`sendMessage` per
 * chunk); those belong to one message and are concatenated, exactly as the web
 * persistence buffer does it. A new message starts when the caller says so
 * (`metadata.segment === 'new'`) or when the category changes — a workflow
 * status is its own bubble in the web UI and its own message on the phone.
 */
export class MirrorBuffer {
  private messages: { category?: string; text: string }[] = [];

  capture(message: string, metadata?: MessageMetadata): void {
    const category = metadata?.category;
    if (category !== undefined && STRUCTURAL_CATEGORIES.has(category)) return;
    if (message === '') return;

    const last = this.messages[this.messages.length - 1];
    const startNew =
      last === undefined || metadata?.segment === 'new' || last.category !== category;
    if (startNew) {
      this.messages.push({ category, text: message });
      return;
    }
    last.text += message;
  }

  /** Everything captured so far, cleared. */
  take(): MirroredMessage[] {
    const taken = this.messages.filter(m => m.text.trim().length > 0);
    this.messages = [];
    return taken;
  }
}

/**
 * Wrap an adapter so every `sendMessage` is also handed to `capture`. Every
 * other member is forwarded untouched, including ones added later.
 *
 * `capture` must not throw: it runs after the primary delivery has already
 * succeeded, and a mirror is never allowed to fail the real answer.
 */
export function withOutboundMirror<T extends IPlatformAdapter>(
  primary: T,
  capture: (message: string, metadata?: MessageMetadata) => void
): T {
  return new Proxy(primary, {
    get(target, prop, _receiver): unknown {
      if (prop === 'sendMessage') {
        return async (
          conversationId: string,
          message: string,
          metadata?: MessageMetadata
        ): Promise<void> => {
          await target.sendMessage(conversationId, message, metadata);
          capture(message, metadata);
        };
      }
      // Bind to the target, not the proxy: adapters are classes with private
      // fields, which throw when accessed through a proxy receiver.
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
