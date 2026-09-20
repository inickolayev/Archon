/**
 * Running the repair pass, and surviving it failing.
 *
 * The prompt and the acceptance contract live next door in `cleanup-prompt.ts`,
 * which is pure and tested directly. This file is the part that talks to a
 * model: it borrows the conversation's own configured assistant, at the
 * cheapest tier that assistant has, with no tools at all, and a timeout.
 *
 * Every failure lands in the same place — the raw transcript, and a note on the
 * message saying the tidy-up did not happen. Losing the operator's words
 * because a side pass timed out would be the worst outcome available.
 */

import { getAgentProvider } from '@archon/providers';
import type { SendQueryOptions } from '@archon/providers/types';
import { resolveTitleRequest } from '@archon/core';
import { createLogger, getArchonWorkspacesPath } from '@archon/paths';
import { acceptCleaned, buildCleanupPrompt } from './cleanup-prompt';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('server.voice.cleanup');
  return cachedLog;
}

export interface CleanTranscriptOptions {
  /** The conversation's provider — the cleaner uses what the chat uses. */
  readonly assistantType: string;
  /** Whose credentials to authenticate with, on per-user installs. */
  readonly userId?: string;
  /** BCP-47 code the recogniser was given, named in the prompt. */
  readonly lang: string;
  readonly timeoutMs: number;
}

export interface CleanedTranscript {
  readonly text: string;
  /** False when `text` is the recogniser's raw output after a failed pass. */
  readonly cleaned: boolean;
}

/**
 * Ask a model to punctuate and respell one transcript.
 *
 * NEVER THROWS. The raw transcript is always a valid answer, so there is no
 * failure this can usefully hand upwards.
 */
export async function cleanTranscript(
  raw: string,
  options: CleanTranscriptOptions
): Promise<CleanedTranscript> {
  const transcript = raw.trim();
  if (transcript.length === 0) return { text: '', cleaned: false };

  try {
    // Resolves the `small` tier for the configured provider — named for its
    // first caller (conversation titles), but tier resolution is all it does,
    // and the repair pass wants exactly the same thing: the cheapest model this
    // install has, authenticated as the sender.
    const request = await resolveTitleRequest(options.assistantType, options.userId);
    const client = getAgentProvider(request.provider);

    const queryOptions: SendQueryOptions = {
      ...request.options,
      abortSignal: AbortSignal.timeout(options.timeoutMs),
      nodeConfig: {
        ...(request.options.nodeConfig ?? {}),
        // Pure text in, pure text out. A repair pass has no business reading a
        // file, and a transcript that asks it to must not find a way.
        allowed_tools: [],
      },
    };

    let answer = '';
    for await (const chunk of client.sendQuery(
      buildCleanupPrompt(transcript, options.lang),
      getArchonWorkspacesPath(),
      undefined,
      queryOptions
    )) {
      if (chunk.type === 'assistant') answer += chunk.content;
    }

    const verdict = acceptCleaned(transcript, answer);
    if (!verdict.ok) {
      // Length, not content: nothing of what was said is written to the log.
      getLog().warn(
        { reason: verdict.reason, rawChars: transcript.length, answerChars: answer.length },
        'voice.cleanup_rejected'
      );
      return { text: transcript, cleaned: false };
    }
    return { text: verdict.text, cleaned: true };
  } catch (err) {
    getLog().warn({ err }, 'voice.cleanup_failed');
    return { text: transcript, cleaned: false };
  }
}
