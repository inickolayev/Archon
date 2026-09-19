/**
 * Albums.
 *
 * Telegram delivers a multi-photo send as several updates that share a
 * `media_group_id`, a few milliseconds apart. Dispatching each one would start
 * a separate agent turn per photo — five answers to one send. This collects
 * the parts of a group and releases them once, as a single message.
 *
 * The wait is deliberately short: it delays only album sends, and a single
 * file (no `media_group_id`) never passes through here at all.
 */

export interface MediaGroupPart<T> {
  /** Caption of this part; only one part of an album usually has one. */
  readonly caption?: string;
  readonly items: readonly T[];
}

interface PendingGroup<T> {
  caption?: string;
  items: T[];
  timer: ReturnType<typeof setTimeout>;
}

export class MediaGroupCollector<T> {
  readonly #pending = new Map<string, PendingGroup<T>>();
  readonly #waitMs: number;
  readonly #onRelease: (groupId: string, group: MediaGroupPart<T>) => void;

  constructor(waitMs: number, onRelease: (groupId: string, group: MediaGroupPart<T>) => void) {
    this.#waitMs = waitMs;
    this.#onRelease = onRelease;
  }

  /**
   * Add one part of an album. The group is released `waitMs` after its **last**
   * part arrives, so a slow album still comes out whole.
   */
  add(groupId: string, part: MediaGroupPart<T>): void {
    const existing = this.#pending.get(groupId);
    if (existing !== undefined) {
      clearTimeout(existing.timer);
      existing.items.push(...part.items);
      // First caption wins: Telegram puts it on one part, and a later empty
      // part must not erase it.
      existing.caption ??= part.caption;
      existing.timer = setTimeout(() => {
        this.#release(groupId);
      }, this.#waitMs);
      return;
    }

    this.#pending.set(groupId, {
      caption: part.caption,
      items: [...part.items],
      timer: setTimeout(() => {
        this.#release(groupId);
      }, this.#waitMs),
    });
  }

  /** Release everything still pending — used when the adapter stops. */
  flushAll(): void {
    for (const groupId of [...this.#pending.keys()]) {
      const group = this.#pending.get(groupId);
      if (group !== undefined) clearTimeout(group.timer);
      this.#release(groupId);
    }
  }

  #release(groupId: string): void {
    const group = this.#pending.get(groupId);
    if (group === undefined) return;
    this.#pending.delete(groupId);
    this.#onRelease(groupId, { caption: group.caption, items: group.items });
  }
}
