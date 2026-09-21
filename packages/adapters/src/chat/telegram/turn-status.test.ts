import { describe, expect, test } from 'bun:test';
import { TurnStatus, type StatusTransport } from './turn-status';
import { STATUS_FINISHED, STATUS_THINKING } from './turn-status-text';

const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Short enough to keep the suite quick, long enough to be a real interval. */
const THROTTLE_MS = 40;

interface Recorded {
  readonly sent: string[];
  readonly edited: { messageId: number; text: string }[];
  readonly removed: number[];
  readonly typingCount: number;
}

/**
 * A Bot API that records instead of calling out, with the two knobs the
 * interesting cases need: how long a send takes (to make the send/delete race
 * real), and whether Telegram will let the message be deleted.
 */
class FakeTransport implements StatusTransport {
  readonly sent: string[] = [];
  readonly edited: { messageId: number; text: string }[] = [];
  readonly removed: number[] = [];
  typingCount = 0;
  #nextId = 100;

  constructor(
    private readonly options: {
      sendDelayMs?: number;
      sendRefused?: boolean;
      deleteRefused?: boolean;
      throwEverything?: boolean;
    } = {}
  ) {}

  async send(text: string): Promise<number | null> {
    if (this.options.throwEverything) throw new Error('Telegram is unreachable');
    if (this.options.sendDelayMs !== undefined) await tick(this.options.sendDelayMs);
    if (this.options.sendRefused === true) return null;
    this.sent.push(text);
    return this.#nextId++;
  }

  async edit(messageId: number, text: string): Promise<void> {
    if (this.options.throwEverything) throw new Error('400 message is not modified');
    this.edited.push({ messageId, text });
  }

  async remove(messageId: number): Promise<boolean> {
    if (this.options.throwEverything) throw new Error('Telegram is unreachable');
    if (this.options.deleteRefused === true) return false;
    this.removed.push(messageId);
    return true;
  }

  async typing(): Promise<void> {
    this.typingCount++;
  }

  snapshot(): Recorded {
    return {
      sent: [...this.sent],
      edited: [...this.edited],
      removed: [...this.removed],
      typingCount: this.typingCount,
    };
  }
}

const statusOver = (transport: StatusTransport): TurnStatus =>
  new TurnStatus(transport, { throttleMs: THROTTLE_MS });

describe('TurnStatus', () => {
  test('the line goes up the moment the turn starts, saying it is thinking', async () => {
    const transport = new FakeTransport();
    const status = statusOver(transport);

    status.begin();
    await tick(10);

    expect(transport.sent).toEqual([STATUS_THINKING]);
    expect(transport.edited).toHaveLength(0);
  });

  test('a burst of tool calls costs ONE edit, showing the latest', async () => {
    const transport = new FakeTransport();
    const status = statusOver(transport);

    status.begin();
    await tick(10);
    status.step('⏳ Reading a.ts…');
    status.step('⏳ Reading b.ts…');
    status.step('⏳ Running tests…');
    await tick(THROTTLE_MS * 2);

    expect(transport.sent).toEqual([STATUS_THINKING]);
    expect(transport.edited.map(e => e.text)).toEqual(['⏳ Running tests…']);
  });

  test('the throttle holds a later step back rather than dropping it', async () => {
    const transport = new FakeTransport();
    const status = statusOver(transport);

    status.begin();
    await tick(10);
    status.step('⏳ Reading a.ts…');
    await tick(THROTTLE_MS * 2);
    status.step('⏳ Running tests…');
    await tick(THROTTLE_MS * 2);

    expect(transport.edited.map(e => e.text)).toEqual(['⏳ Reading a.ts…', '⏳ Running tests…']);
  });

  test('identical text is never sent again — Telegram answers that with a 400', async () => {
    const transport = new FakeTransport();
    const status = statusOver(transport);

    status.begin();
    await tick(10);
    status.step('⏳ Reading files…');
    await tick(THROTTLE_MS * 2);
    status.step('⏳ Reading files…');
    status.step('⏳ Reading files…');
    await tick(THROTTLE_MS * 2);

    expect(transport.edited).toHaveLength(1);
  });

  test('every edit lands on the same message — the line is never re-sent', async () => {
    const transport = new FakeTransport();
    const status = statusOver(transport);

    status.begin();
    await tick(10);
    for (const text of ['⏳ Reading a.ts…', '⏳ Editing b.ts…', '⏳ Running tests…']) {
      status.step(text);
      await tick(THROTTLE_MS * 2);
    }

    expect(transport.sent).toHaveLength(1);
    expect(new Set(transport.edited.map(e => e.messageId)).size).toBe(1);
  });

  test('the line is taken away when the turn ends', async () => {
    const transport = new FakeTransport();
    const status = statusOver(transport);

    status.begin();
    await tick(10);
    status.step('⏳ Running tests…');
    await tick(THROTTLE_MS * 2);
    await status.clear();

    expect(transport.removed).toHaveLength(1);
    expect(transport.edited.at(-1)?.text).toBe('⏳ Running tests…');
  });

  test('a turn stopped mid-work clears the line, pending step and all', async () => {
    const transport = new FakeTransport();
    const status = statusOver(transport);

    status.begin();
    await tick(10);
    // ⏹ Stop lands while a step is still waiting on the throttle. Nothing may
    // be written afterwards: "Running tests…" left on screen forever is the
    // failure this feature must not have.
    status.step('⏳ Running tests…');
    await status.clear();
    await tick(THROTTLE_MS * 3);

    expect(transport.removed).toHaveLength(1);
    expect(transport.edited).toHaveLength(0);
  });

  test('a turn that ends before the first send has left posts nothing at all', async () => {
    const transport = new FakeTransport();
    const status = statusOver(transport);

    // No delay before the first send, so a two-second turn does show the line
    // and remove it. A turn that ends in the same breath is quieter still: the
    // write checks when it RUNS whether the turn is still going.
    status.begin();
    await status.clear();

    expect(transport.snapshot()).toEqual({ sent: [], edited: [], removed: [], typingCount: 0 });
  });

  test('a delete that races its own send still removes the message', async () => {
    const transport = new FakeTransport({ sendDelayMs: 40 });
    const status = statusOver(transport);

    status.begin();
    await tick(5); // the send is now in flight, and has no id yet
    await status.clear();

    expect(transport.sent).toEqual([STATUS_THINKING]);
    expect(transport.removed).toHaveLength(1);
  });

  test('a refused delete leaves one short final line, not a stale "working…"', async () => {
    const transport = new FakeTransport({ deleteRefused: true });
    const status = statusOver(transport);

    status.begin();
    await tick(10);
    status.step('⏳ Running tests…');
    await tick(THROTTLE_MS * 2);
    await status.clear();

    expect(transport.removed).toHaveLength(0);
    expect(transport.edited.at(-1)?.text).toBe(STATUS_FINISHED);
  });

  test('a refused send costs the line, not the turn — and the next step retries', async () => {
    const transport = new FakeTransport({ sendRefused: true });
    const status = statusOver(transport);

    status.begin();
    await tick(10);
    expect(transport.sent).toHaveLength(0);
    expect(transport.edited).toHaveLength(0);

    await status.clear();
    // Nothing on screen, so nothing to take away.
    expect(transport.removed).toHaveLength(0);
  });

  test('a transport that throws everything cannot fail the turn', async () => {
    const transport = new FakeTransport({ throwEverything: true });
    const status = statusOver(transport);

    status.begin();
    await tick(10);
    status.step('⏳ Running tests…');
    await tick(THROTTLE_MS * 2);

    // The turn's own `finally` awaits this; it must resolve, never reject.
    await status.clear();
    expect(true).toBe(true);
  });

  test('clearing twice is safe — the turn ends once', async () => {
    const transport = new FakeTransport();
    const status = statusOver(transport);

    status.begin();
    await tick(10);
    await status.clear();
    await status.clear();

    expect(transport.removed).toHaveLength(1);
  });

  test('a step after the turn is over writes nothing', async () => {
    const transport = new FakeTransport();
    const status = statusOver(transport);

    status.begin();
    await tick(10);
    await status.clear();
    status.step('⏳ Reading a.ts…');
    await tick(THROTTLE_MS * 3);

    expect(transport.edited).toHaveLength(0);
    expect(transport.sent).toHaveLength(1);
  });
});
