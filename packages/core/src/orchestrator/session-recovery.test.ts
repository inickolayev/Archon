import { describe, expect, test } from 'bun:test';
import type { MessageChunk } from '@archon/providers/types';
import { isLostSessionResult, withRecoveredSession } from './session-recovery';

const LOST: MessageChunk = {
  type: 'result',
  isError: true,
  errorSubtype: 'error_during_execution',
  sessionId: 'gone-abc',
};
const OK = (sessionId: string): MessageChunk => ({ type: 'result', sessionId });
const say = (content: string): MessageChunk => ({ type: 'assistant', content });

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

describe('isLostSessionResult', () => {
  test('recognises the provider result for a resume that found nothing', () => {
    expect(isLostSessionResult(LOST)).toBe(true);
  });

  test('is not fooled by other failures or by a clean result', () => {
    expect(isLostSessionResult({ type: 'result', isError: true, errorSubtype: 'rate_limit' })).toBe(
      false
    );
    expect(isLostSessionResult(OK('live'))).toBe(false);
    expect(isLostSessionResult(say('hello'))).toBe(false);
  });
});

describe('withRecoveredSession', () => {
  test('passes a healthy turn through untouched and replays nothing', async () => {
    const provider = scriptedProvider([[say('hi'), OK('same-session')]]);
    let replayCalls = 0;

    const chunks = await drain(
      withRecoveredSession({
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

  test('a lost session is answered, not reported, with the history in front of it', async () => {
    const provider = scriptedProvider([[LOST], [say('carrying on'), OK('fresh-session')]]);
    const lost: (string | undefined)[] = [];
    const recovered: { replayed: boolean }[] = [];

    const chunks = await drain(
      withRecoveredSession({
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
    expect(chunks).toEqual([say('carrying on'), OK('fresh-session')]);
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

    expect(chunks).toEqual([say('fresh start'), OK('fresh')]);
    expect(provider.calls[1]?.prompt).toBe('PROMPT');
    expect(recovered).toEqual([{ replayed: false }]);
  });

  test('does not retry when no resume was attempted — that failure is real', async () => {
    const provider = scriptedProvider([[LOST]]);

    const chunks = await drain(
      withRecoveredSession({
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
    const warning: MessageChunk = { type: 'system', content: '⚠️ something' };
    const provider = scriptedProvider([
      [warning, LOST],
      [say('recovered'), OK('fresh')],
    ]);

    const chunks = await drain(
      withRecoveredSession({
        sendQuery: provider.sendQuery,
        prompt: 'PROMPT',
        resumeSessionId: 'gone-abc',
        loadReplay: () => Promise.resolve('REPLAY'),
        onSessionLost: () => Promise.resolve(),
      })
    );

    expect(chunks).toEqual([warning, say('recovered'), OK('fresh')]);
    expect(provider.calls).toHaveLength(2);
  });

  test('a second lost session in the retry is surfaced rather than looped on', async () => {
    const provider = scriptedProvider([[LOST], [LOST]]);

    const chunks = await drain(
      withRecoveredSession({
        sendQuery: provider.sendQuery,
        prompt: 'PROMPT',
        resumeSessionId: 'gone-abc',
        loadReplay: () => Promise.resolve('REPLAY'),
        onSessionLost: () => Promise.resolve(),
      })
    );

    expect(chunks).toEqual([LOST]);
    expect(provider.calls).toHaveLength(2);
  });
});
