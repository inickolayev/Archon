/**
 * Move one item of a list to another index, returning a new list. Used by the
 * drag-to-reorder attachments: `from` is the dragged item, `to` the slot it was
 * dropped on. Out-of-range indices leave the list untouched.
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to) return [...list];
  if (from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const next = [...list];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return [...list];
  next.splice(to, 0, moved);
  return next;
}
