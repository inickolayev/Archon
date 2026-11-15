import { describe, expect, test } from 'bun:test';
import type { MessageChunk } from '@archon/providers/types';
import { withRecoveredSession } from './session-recovery';

// The provider's structured "that session is not here" (see `sessionNotFound`).
const LOST: MessageChunk = {
  type: 'result',
  isError: true,
  errorSubtype: 'error_during_execution',
  sessionId: 'gone-abc',
  sessionNotFound: true,
};
const OK = (sessionId: string): MessageChunk => ({ type: 'result', sessionId });
/** A result from the fresh attempt: the shared retry marks it as not resumed. */
const FRESH = (chunk: MessageChunk): MessageChunk =>
  chunk.type === 'result' ? { ...chunk, resumed: false } : chunk;
const say = (text: string): MessageChunk => ({ type: 'agent_message_chunk', text });

/** A provider that answers each attempt with a scripted chunk list. */
function scriptedProvider(scripts: readonly (readonly MessageChunk[])[]): {
  sendQuery: (prompt: string, resumeSessionId?: string) => AsyncGenerator<MessageChunk>;
  calls: { prompt: string; resumeSessionId?: string }[];
} {
  const calls: { prompt: string; resumeSessionId?: string }[] = [];
  async function* sendQuery(
    prompt: string,
    resumeSessionId?: string
  ): AsyncGenerator<MessageChunk> {
    const index = calls.length;
    calls.push({ prompt, ...(resumeSessionId !== undefined ? { resumeSessionId } : {}) });
    for (const chunk of scripts[index] ?? []) yield chunk;
  }
  return { sendQuery, calls };
}

async function drain(stream: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const out: MessageChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe('withRecoveredSession', () => {
  test('passes a healthy turn through untouched and replays nothing', async () => {
    const provider = scriptedProvider([[say('hi'), OK('same-session')]]);
    let replayCalls = 0;

    const chunks = await drain(
      withRecoveredSession({
        logContext: {},
        sendQuery: provider.sendQuery,
        prompt: 'PROMPT',
        resumeSessionId: 'live-1',
        loadReplay: () => {
          replayCalls++;
          return Promise.resolve('REPLAY');
        },
        onSessionLost: () => Promise.resolve(),
      })
    );

    expect(chunks).toEqual([say('hi'), OK('same-session')]);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.prompt).toBe('PROMPT');
    expect(replayCalls).toBe(0);
  });

  test('a failure the provider does not mark as a lost session is not retried', async () => {
    const plainFailure: MessageChunk = {
      type: 'result',
      isError: true,
      errorSubtype: 'error_during_execution',
      sessionId: 'live-1',
    };
    const provider = scriptedProvider([[plainFailure]]);

    const chunks = await drain(
      withRecoveredSession({
        logContext: {},
        sendQuery: provider.sendQuery,
        prompt: 'PROMPT',
        resumeSessionId: 'live-1',
        loadReplay: () => Promise.resolve('REPLAY'),
        onSessionLost: () => Promise.resolve(),
      })
    );

    expect(chunks).toEqual([plainFailure]);
    expect(provider.calls).toHaveLength(1);
  });

  test('a lost session is answered, not reported, with the history in front of it', async () => {
    const provider = scriptedProvider([[LOST], [say('carrying on'), OK('fresh-session')]]);
    const lost: (string | undefined)[] = [];
    const recovered: { replayed: boolean }[] = [];

    const chunks = await drain(
      withRecoveredSession({
        logContext: {},
        sendQuery: provider.sendQuery,
        prompt: 'PROMPT',
        resumeSessionId: 'gone-abc',
        loadReplay: () => Promise.resolve('REPLAY'),
        onSessionLost: id => {
          lost.push(id);
          return Promise.resolve();
        },
        onRecovered: info => {
          recovered.push(info);
          return Promise.resolve();
        },
      })
    );

    // The failing result never reaches the handler, so no error is shown.
    expect(chunks).toEqual([say('carrying on'), FRESH(OK('fresh-session'))]);
    expect(lost).toEqual(['gone-abc']);
    expect(recovered).toEqual([{ replayed: true }]);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.prompt).toBe('REPLAY\n\n---\n\nPROMPT');
    // The retry must start fresh, or it could fail the same way forever.
    expect(provider.calls[1]?.resumeSessionId).toBeUndefined();
  });

  test('recovers even when there is no history to replay', async () => {
    const provider = scriptedProvider([[LOST], [say('fresh start'), OK('fresh')]]);
    const recovered: { replayed: boolean }[] = [];

    const chunks = await drain(
      withRecoveredSession({
        logContext: {},
        sendQuery: provider.sendQuery,
        prompt: 'PROMPT',
        resumeSessionId: 'gone-abc',
        loadReplay: () => Promise.resolve(''),
        onSessionLost: () => Promise.resolve(),
        onRecovered: info => {
          recovered.push(info);
          return Promise.resolve();
        },
      })
    );

    expect(chunks).toEqual([say('fresh start'), FRESH(OK('fresh'))]);
    expect(provider.calls[1]?.prompt).toBe('PROMPT');
    expect(recovered).toEqual([{ replayed: false }]);
  });

  test('does not retry when no resume was attempted — that failure is real', async () => {
    const provider = scriptedProvider([[LOST]]);

    const chunks = await drain(
      withRecoveredSession({
        logContext: {},
        sendQuery: provider.sendQuery,
        prompt: 'PROMPT',
        loadReplay: () => Promise.resolve('REPLAY'),
        onSessionLost: () => Promise.resolve(),
      })
    );

    expect(chunks).toEqual([LOST]);
    expect(provider.calls).toHaveLength(1);
  });

  test('does not retry once the operator has already seen output', async () => {
    const provider = scriptedProvider([[say('half an answer'), LOST]]);

    const chunks = await drain(
      withRecoveredSession({
        logContext: {},
        sendQuery: provider.sendQuery,
        prompt: 'PROMPT',
        resumeSessionId: 'live-1',
        loadReplay: () => Promise.resolve('REPLAY'),
        onSessionLost: () => Promise.resolve(),
      })
    );

    expect(chunks).toEqual([say('half an answer'), LOST]);
    expect(provider.calls).toHaveLength(1);
  });

  test('a provider warning ahead of the failure does not block recovery', async () => {
    const warning: MessageChunk = {
      type: 'warning',
      code: 'test.something',
      message: '⚠️ something',
    };
    const provider = scriptedProvider([
      [warning, LOST],
      [say('recovered'), OK('fresh')],
    ]);

    const chunks = await drain(
      withRecoveredSession({
        logContext: {},
        sendQuery: provider.sendQuery,
        prompt: 'PROMPT',
        resumeSessionId: 'gone-abc',
        loadReplay: () => Promise.resolve('REPLAY'),
        onSessionLost: () => Promise.resolve(),
      })
    );

    expect(chunks).toEqual([warning, say('recovered'), FRESH(OK('fresh'))]);
    expect(provider.calls).toHaveLength(2);
  });

  test('a second lost session in the retry is surfaced rather than looped on', async () => {
    const provider = scriptedProvider([[LOST], [LOST]]);

    const chunks = await drain(
      withRecoveredSession({
        logContext: {},
        sendQuery: provider.sendQuery,
        prompt: 'PROMPT',
        resumeSessionId: 'gone-abc',
        loadReplay: () => Promise.resolve('REPLAY'),
        onSessionLost: () => Promise.resolve(),
      })
    );

    expect(chunks).toEqual([FRESH(LOST)]);
    expect(provider.calls).toHaveLength(2);
  });
});
