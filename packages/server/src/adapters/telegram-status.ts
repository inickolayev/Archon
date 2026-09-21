/**
 * Feeding the phone's status line from the same stream the console's trace is.
 *
 * The console builds "Agent is working · Read" out of the structured event
 * stream: the orchestrator hands every tool call to `sendStructuredEvent`, the
 * web adapter turns it into an SSE frame, and `ChatPage` shows the latest tool
 * name. Telegram never implemented that member, so the orchestrator skipped it
 * and the phone learned nothing.
 *
 * This wrapper implements it for Telegram — not to display the events, but to
 * read them. The RAW chunk is what arrives here (`toolName`, `toolInput`),
 * which matters: the formatted arm of the same stream
 * (`sendMessage(…, 'tool_call_formatted')`) has the operator's absolute paths
 * baked into its text, and re-parsing display text to get them back out again
 * would be inventing a second channel and a path leak at the same time. The
 * words shown are chosen from the tool name in `turn-status-text.ts` instead.
 *
 * `sendMessage` is deliberately NOT intercepted. The line is cleared where the
 * turn ends, not where its first sentence is delivered — a turn that says "let
 * me look at that" and then works for three minutes must not go silent after
 * the preamble.
 */

import { z } from 'zod';
import { createLogger } from '@archon/paths';
import type { IPlatformAdapter } from '@archon/core';
import type { MessageChunk } from '@archon/providers/types';
import { TurnStatus, describeTool, type StatusTransport } from '@archon/adapters';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('server.telegram-status');
  return cachedLog;
}

const schema = z.object({
  /** Off leaves Telegram exactly as it was: silence until the answer lands. */
  TELEGRAM_STATUS_ENABLED: z
    .string()
    .default('true')
    .transform(v => v !== 'false' && v !== '0'),
  /**
   * Shortest gap between two edits of the line.
   *
   * Three seconds. Telegram's flood limits for a chat are around one message a
   * second, and an edit counts against them; a turn that calls twenty tools in
   * a minute would otherwise spend its allowance on decoration and start
   * getting 429s on the answer. Three seconds is slow enough to be nowhere near
   * that ceiling and fast enough that the line still reads as live — the
   * console's own indicator changes about as often. The floor below keeps a
   * mistyped value from turning this into a rate-limit generator.
   */
  TELEGRAM_STATUS_THROTTLE_MS: z.coerce.number().int().min(1000).max(60_000).default(3000),
});

export type TelegramStatusConfig = z.infer<typeof schema>;

/** The knobs, re-read per call and never trusted — a typo takes the default. */
export function telegramStatusConfig(env: NodeJS.ProcessEnv = process.env): TelegramStatusConfig {
  const parsed = schema.safeParse(env);
  if (parsed.success) return parsed.data;
  getLog().warn(
    { issues: parsed.error.issues.map(i => i.path.join('.')) },
    'telegram.status_config_invalid_using_defaults'
  );
  return schema.parse({});
}

/** The status line for one turn, or null when this install has it switched off. */
export function createTurnStatus(
  transportFor: (conversationId: string) => StatusTransport,
  conversationId: string,
  config: TelegramStatusConfig = telegramStatusConfig()
): TurnStatus | null {
  if (!config.TELEGRAM_STATUS_ENABLED) return null;
  try {
    return new TurnStatus(transportFor(conversationId), {
      throttleMs: config.TELEGRAM_STATUS_THROTTLE_MS,
    });
  } catch (err) {
    // Only reachable when the conversation id is not a Telegram chat id, which
    // would be a wiring bug. Worth a line, never worth losing the turn.
    getLog().warn({ err, conversationId }, 'telegram.status_transport_unavailable');
    return null;
  }
}

/**
 * Wrap an adapter so the tool events of a turn drive its status line.
 *
 * A Proxy for the same reason `withOutboundMirror` is one: the orchestrator
 * reaches for optional, platform-specific members, and forwarding everything by
 * construction is the only version of this that cannot silently lose one. Here
 * it also ADDS a member the underlying adapter does not have, which is why this
 * wrap must be the outermost of the Telegram chain — an inner proxy asked for
 * `sendStructuredEvent` would answer for the bare adapter, which has none.
 */
export function withTurnStatus<T extends IPlatformAdapter>(
  primary: T,
  status: TurnStatus | null
): T {
  if (status === null) return primary;
  return new Proxy(primary, {
    get(target, prop, _receiver): unknown {
      if (prop === 'sendStructuredEvent') {
        return async (conversationId: string, event: MessageChunk): Promise<void> => {
          // Synchronous and self-guarding: `step` only records what to say
          // next, so nothing here can delay or fail the turn's own work.
          if (event.type === 'tool') status.step(describeTool(event.toolName, event.toolInput));
          // Forwarded when the wrapped adapter has one of its own, so this
          // stays a decoration on the chain rather than a hole in it.
          const forward = Reflect.get(target, prop, target) as unknown;
          if (typeof forward === 'function') {
            await (forward as (id: string, e: MessageChunk) => Promise<void>)(
              conversationId,
              event
            );
          }
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
