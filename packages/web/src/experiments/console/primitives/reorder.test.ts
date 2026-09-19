import { describe, test, expect } from 'bun:test';
import { moveItem } from './reorder';

describe('moveItem', () => {
  test('moves an item forward', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
  });

  test('moves an item backward', () => {
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });

  test('is a no-op when the item does not move', () => {
    expect(moveItem(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });

  test('ignores out-of-range indices', () => {
    expect(moveItem(['a', 'b'], 0, 5)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b'], -1, 0)).toEqual(['a', 'b']);
  });

  test('never mutates the input', () => {
    const list = ['a', 'b', 'c'];
    moveItem(list, 0, 2);
    expect(list).toEqual(['a', 'b', 'c']);
  });
});
