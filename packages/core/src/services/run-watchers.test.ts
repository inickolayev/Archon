import { describe, expect, test } from 'bun:test';
import type { AttentionNoticeRecord } from '../db/workflow-events';
import {
  TELEGRAM_ATTENTION_DESTINATION,
  pauseWasTold,
  runWatchers,
  telegramRecipients,
  watchRecord,
} from './run-watchers';

const RUN = 'run-1';
const OTHER = 'run-2';

function row(runId: string, data: AttentionNoticeRecord['data']): AttentionNoticeRecord {
  return { runId, data };
}
const watch = (chat: string, runId = RUN): AttentionNoticeRecord =>
  row(runId, watchRecord(chat, true));
const unwatch = (chat: string, runId = RUN): AttentionNoticeRecord =>
  row(runId, watchRecord(chat, false));
const pause = (key = 'review:1', destination = TELEGRAM_ATTENTION_DESTINATION) =>
  row(RUN, { destination, key });

describe('runWatchers', () => {
  test('a chat that asked to watch is watching', () => {
    expect([...runWatchers([watch('100')], RUN)]).toEqual(['100']);
  });

  test('the latest word wins: unwatch after watch stops, watch again resumes', () => {
    expect([...runWatchers([watch('100'), unwatch('100')], RUN)]).toEqual([]);
    expect([...runWatchers([watch('100'), unwatch('100'), watch('100')], RUN)]).toEqual(['100']);
  });

  test('another run’s watchers and other destinations’ rows do not count', () => {
    const records = [
      watch('100', OTHER),
      row(RUN, { destination: 'telegram:100', key: 'watch@200', conversationId: '200' }),
    ];
    expect([...runWatchers(records, RUN)]).toEqual([]);
  });
});

describe('pauseWasTold', () => {
  test('a recorded pause notice counts', () => {
    expect(pauseWasTold([pause()], RUN)).toBe(true);
  });

  test('subscriptions, baselines, terminals and other destinations do not', () => {
    const records = [
      watch('100'),
      unwatch('100'),
      row(RUN, { destination: TELEGRAM_ATTENTION_DESTINATION, key: 'gate:1', baseline: true }),
      row(RUN, { destination: TELEGRAM_ATTENTION_DESTINATION, key: 'terminal' }),
      pause('review:1', 'web-push'),
    ];
    expect(pauseWasTold(records, RUN)).toBe(false);
  });
});

describe('telegramRecipients', () => {
  // A run someone started, whose account has Telegram linked as chat 1.
  const base = {
    authored: true,
    authorChat: '1',
    allRunsWatchers: ['9'],
    watchers: new Set<string>(),
    pauseTold: false,
  };

  test('a pause goes to its author, the chat that started the run and its watchers', () => {
    expect(
      telegramRecipients({ ...base, kind: 'gate', starterChat: '2', watchers: new Set(['3']) })
    ).toEqual(['1', '2', '3']);
  });

  test('a run nobody started calls the chats that watch every such run', () => {
    expect(
      telegramRecipients({ ...base, authored: false, authorChat: undefined, kind: 'gate' })
    ).toEqual(['9']);
  });

  test('a run with an author never calls the all-runs watchers, even without Telegram linked', () => {
    expect(telegramRecipients({ ...base, authorChat: undefined, kind: 'gate' })).toEqual([]);
  });

  test('one chat hears a notice once, whatever roles it holds', () => {
    expect(
      telegramRecipients({ ...base, kind: 'attention', starterChat: '1', watchers: new Set(['1']) })
    ).toEqual(['1']);
  });

  test('the chat the run itself talks in was told inline and is skipped', () => {
    expect(
      telegramRecipients({ ...base, kind: 'gate', ownChat: '1', watchers: new Set(['3']) })
    ).toEqual(['3']);
  });

  test('the end goes to watchers, and to the author only when they were told of a pause', () => {
    const watchers = new Set(['3']);
    expect(telegramRecipients({ ...base, kind: 'terminal', watchers })).toEqual(['3']);
    expect(telegramRecipients({ ...base, kind: 'terminal', watchers, pauseTold: true })).toEqual([
      '1',
      '3',
    ]);
  });

  test('the all-runs watchers hear an end only after they were called to a pause', () => {
    const authorless = {
      ...base,
      authored: false,
      authorChat: undefined,
      kind: 'terminal' as const,
    };
    expect(telegramRecipients(authorless)).toEqual([]);
    expect(telegramRecipients({ ...authorless, pauseTold: true })).toEqual(['9']);
  });

  test('a run that paused ended elsewhere: the chat that started it hears the end', () => {
    expect(
      telegramRecipients({ ...base, kind: 'terminal', pauseTold: true, starterChat: '2' })
    ).toEqual(['1', '2']);
  });

  test('a run that never paused brought its result card to the chat that started it', () => {
    expect(
      telegramRecipients({
        ...base,
        kind: 'terminal',
        starterChat: '2',
        watchers: new Set(['2', '3']),
      })
    ).toEqual(['3']);
  });

  test('nobody to call and nobody watching: nobody to tell', () => {
    expect(
      telegramRecipients({ ...base, authored: false, allRunsWatchers: [], kind: 'gate' })
    ).toEqual([]);
  });
});
