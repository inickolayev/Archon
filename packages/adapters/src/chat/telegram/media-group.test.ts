import { describe, expect, test } from 'bun:test';
import { MediaGroupCollector, type MediaGroupPart } from './media-group';

const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe('MediaGroupCollector', () => {
  test('an album of three photos comes out as ONE message', async () => {
    const released: { id: string; group: MediaGroupPart<string> }[] = [];
    const collector = new MediaGroupCollector<string>(20, (id, group) =>
      released.push({ id, group })
    );

    collector.add('album-1', { caption: 'three shots', items: ['a'] });
    collector.add('album-1', { items: ['b'] });
    collector.add('album-1', { items: ['c'] });

    expect(released).toHaveLength(0); // nothing yet — still collecting
    await tick(40);

    expect(released).toHaveLength(1);
    expect(released[0]?.id).toBe('album-1');
    expect(released[0]?.group.items).toEqual(['a', 'b', 'c']);
    expect(released[0]?.group.caption).toBe('three shots');
  });

  test('the caption survives even when it is not on the first part', async () => {
    const released: MediaGroupPart<string>[] = [];
    const collector = new MediaGroupCollector<string>(20, (_id, group) => released.push(group));

    collector.add('album-2', { items: ['a'] });
    collector.add('album-2', { caption: 'look at this', items: ['b'] });
    await tick(40);

    expect(released[0]?.caption).toBe('look at this');
  });

  test('a later part keeps the group open — a slow album still arrives whole', async () => {
    const released: MediaGroupPart<string>[] = [];
    const collector = new MediaGroupCollector<string>(30, (_id, group) => released.push(group));

    collector.add('album-3', { items: ['a'] });
    await tick(20);
    collector.add('album-3', { items: ['b'] });
    await tick(20);
    expect(released).toHaveLength(0);
    await tick(30);

    expect(released).toHaveLength(1);
    expect(released[0]?.items).toEqual(['a', 'b']);
  });

  test('two albums at once stay separate', async () => {
    const released: { id: string; group: MediaGroupPart<string> }[] = [];
    const collector = new MediaGroupCollector<string>(20, (id, group) =>
      released.push({ id, group })
    );

    collector.add('album-a', { items: ['a1'] });
    collector.add('album-b', { items: ['b1'] });
    collector.add('album-a', { items: ['a2'] });
    await tick(40);

    expect(released).toHaveLength(2);
    const byId = new Map(released.map(r => [r.id, r.group.items]));
    expect(byId.get('album-a')).toEqual(['a1', 'a2']);
    expect(byId.get('album-b')).toEqual(['b1']);
  });

  test('flushAll releases what is pending without waiting', () => {
    const released: MediaGroupPart<string>[] = [];
    const collector = new MediaGroupCollector<string>(10_000, (_id, group) => released.push(group));

    collector.add('album-4', { items: ['a'] });
    collector.flushAll();

    expect(released).toHaveLength(1);
    expect(released[0]?.items).toEqual(['a']);
  });
});
