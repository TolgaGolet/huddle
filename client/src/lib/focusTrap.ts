/**
 * Index to focus next when moving through `count` items, wrapping at the ends.
 * `current` is -1 when focus is outside the items. Null when there are none.
 */
export function nextFocusIndex(count: number, current: number, backwards: boolean): number | null {
  if (count === 0) return null;
  if (current < 0) return backwards ? count - 1 : 0;
  return (current + (backwards ? -1 : 1) + count) % count;
}

/** Moves focus to the next of `items`, wrapping at the ends. */
export function cycleFocus(items: HTMLElement[], backwards: boolean): void {
  const next = nextFocusIndex(items.length, items.indexOf(document.activeElement as HTMLElement), backwards);
  if (next !== null) items[next].focus();
}
