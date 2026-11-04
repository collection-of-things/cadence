import type { QueueItem, QueueState } from "@cadence/protocol";

/**
 * Pure queue transitions. `items[]` stays in base order; when `shuffle` is
 * on, `shuffleOrder` is a permutation of item indices giving play order.
 * `currentIndex` always indexes into `items[]`.
 */

/** The queue entry currently loaded/playing, or null. */
export function currentItem(queue: QueueState): QueueItem | null {
  if (queue.currentIndex < 0 || queue.currentIndex >= queue.items.length) return null;
  return queue.items[queue.currentIndex] ?? null;
}

/** Build an empty, coordinator-owned queue. */
export function emptyQueue(): QueueState {
  return { owner: "coordinator", items: [], currentIndex: -1, shuffle: false, repeat: "off" };
}

/** Position of `itemIndex` within play order (identity when unshuffled). */
function playPositionOf(queue: QueueState, itemIndex: number): number {
  if (!queue.shuffle || !queue.shuffleOrder) return itemIndex;
  const pos = queue.shuffleOrder.indexOf(itemIndex);
  return pos === -1 ? itemIndex : pos;
}

/** Item index at a play-order position, or null when out of range. */
function itemAtPlayPosition(queue: QueueState, playPos: number): number | null {
  if (playPos < 0 || playPos >= queue.items.length) return null;
  if (!queue.shuffle || !queue.shuffleOrder) return playPos;
  const idx = queue.shuffleOrder[playPos];
  return idx === undefined ? null : idx;
}

/**
 * Index to play next on automatic advance (trackEnded).
 * repeat "one" replays the current item; "all" wraps; "off" ends the queue.
 */
export function nextIndexAfterEnd(queue: QueueState): number | null {
  if (queue.items.length === 0 || queue.currentIndex < 0) return null;
  if (queue.repeat === "one") return queue.currentIndex;
  const pos = playPositionOf(queue, queue.currentIndex);
  const next = itemAtPlayPosition(queue, pos + 1);
  if (next !== null) return next;
  if (queue.repeat === "all") return itemAtPlayPosition(queue, 0);
  return null;
}

/**
 * Index for a manual `next` command. Like auto-advance, except repeat "one"
 * still skips forward (a manual skip means "not this track").
 */
export function nextIndexManual(queue: QueueState): number | null {
  if (queue.items.length === 0) return null;
  if (queue.currentIndex < 0) return itemAtPlayPosition(queue, 0);
  const pos = playPositionOf(queue, queue.currentIndex);
  const next = itemAtPlayPosition(queue, pos + 1);
  if (next !== null) return next;
  if (queue.repeat === "all") return itemAtPlayPosition(queue, 0);
  return null;
}

/** Index for a manual `previous` command (play order, clamped at the start). */
export function previousIndexManual(queue: QueueState): number | null {
  if (queue.items.length === 0) return null;
  if (queue.currentIndex < 0) return null;
  const pos = playPositionOf(queue, queue.currentIndex);
  const prev = itemAtPlayPosition(queue, pos - 1);
  if (prev !== null) return prev;
  if (queue.repeat === "all") return itemAtPlayPosition(queue, queue.items.length - 1);
  return null;
}

/** Replace the whole queue; re-stamps nothing (caller owns queueId policy). */
export function replaceQueue(items: QueueItem[], startIndex: number): QueueState {
  const currentIndex = items.length === 0 ? -1 : Math.min(Math.max(startIndex, 0), items.length - 1);
  return { owner: "coordinator", items, currentIndex, shuffle: false, repeat: "off" };
}

/** Insert items so they play immediately after the current play position. */
export function insertNext(queue: QueueState, items: QueueItem[]): QueueState {
  if (items.length === 0) return queue;
  const baseInsertAt = queue.currentIndex < 0 ? queue.items.length : queue.currentIndex + 1;
  const nextItems = [...queue.items];
  nextItems.splice(baseInsertAt, 0, ...items);
  if (!queue.shuffle || !queue.shuffleOrder) return { ...queue, items: nextItems };
  const newIndices = items.map((_, i) => baseInsertAt + i);
  const order = remapOrder(queue.shuffleOrder, queue.items.length, baseInsertAt, items.length);
  order.splice(playPositionOf(queue, queue.currentIndex) + 1, 0, ...newIndices);
  return { ...queue, items: nextItems, shuffleOrder: order };
}

/** Append items at the end of the queue (and of the play order). */
export function append(queue: QueueState, items: QueueItem[]): QueueState {
  if (items.length === 0) return queue;
  const start = queue.items.length;
  const nextItems = [...queue.items, ...items];
  if (!queue.shuffle || !queue.shuffleOrder) return { ...queue, items: nextItems };
  return { ...queue, items: nextItems, shuffleOrder: [...queue.shuffleOrder, ...items.map((_, i) => start + i)] };
}

/** Remove entries by queueId; adjusts currentIndex to keep tracking the same item. */
export function removeByQueueIds(queue: QueueState, queueIds: ReadonlyArray<string>): QueueState {
  const drop = new Set(queueIds);
  const oldCurrent = currentItem(queue);
  const kept = queue.items.filter((it) => !drop.has(it.queueId));
  let currentIndex = -1;
  if (oldCurrent && !drop.has(oldCurrent.queueId)) {
    currentIndex = kept.findIndex((it) => it.queueId === oldCurrent.queueId);
  } else if (queue.currentIndex >= 0 && kept.length > 0) {
    currentIndex = Math.min(queue.currentIndex, kept.length - 1);
  }
  // Rebuild the play order against shifted indices.
  const oldToNew = new Map<number, number>();
  let cursor = 0;
  queue.items.forEach((it, oldIdx) => {
    if (!drop.has(it.queueId)) {
      oldToNew.set(oldIdx, cursor);
      cursor += 1;
    }
  });
  const shuffleOrder = queue.shuffleOrder
    ?.map((oldIdx) => oldToNew.get(oldIdx))
    .filter((i): i is number => i !== undefined);
  return {
    ...queue,
    items: kept,
    currentIndex,
    ...(shuffleOrder !== undefined ? { shuffleOrder } : {}),
  };
}

/** Move the item at `fromIndex` to `toIndex` in base order. */
export function move(queue: QueueState, fromIndex: number, toIndex: number): QueueState {
  if (
    fromIndex < 0 ||
    fromIndex >= queue.items.length ||
    toIndex < 0 ||
    toIndex >= queue.items.length ||
    fromIndex === toIndex
  ) {
    return queue;
  }
  const items = [...queue.items];
  const [moved] = items.splice(fromIndex, 1);
  if (moved === undefined) return queue;
  items.splice(toIndex, 0, moved);
  const remap = (old: number): number => {
    if (old === fromIndex) return toIndex;
    if (fromIndex < toIndex && old > fromIndex && old <= toIndex) return old - 1;
    if (toIndex < fromIndex && old >= toIndex && old < fromIndex) return old + 1;
    return old;
  };
  const currentIndex = queue.currentIndex < 0 ? -1 : remap(queue.currentIndex);
  const shuffleOrder = queue.shuffleOrder?.map(remap);
  return { ...queue, items, currentIndex, ...(shuffleOrder !== undefined ? { shuffleOrder } : {}) };
}

/** Fisher–Yates permutation with `firstIndex` pinned to play position 0. */
export function makeShuffleOrder(length: number, firstIndex: number, rand: () => number): number[] {
  const order = Array.from({ length }, (_, i) => i);
  for (let i = length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const a = order[i] ?? 0;
    order[i] = order[j] ?? 0;
    order[j] = a;
  }
  const pos = order.indexOf(firstIndex);
  if (pos > 0) {
    order[pos] = order[0] ?? firstIndex;
    order[0] = firstIndex;
  }
  return order;
}

/** Toggle shuffle; enabling builds a play order starting at the current item. */
export function setShuffle(queue: QueueState, shuffle: boolean, rand: () => number): QueueState {
  if (shuffle === queue.shuffle) return queue;
  if (!shuffle) return { ...queue, shuffle: false };
  const order = makeShuffleOrder(queue.items.length, Math.max(queue.currentIndex, 0), rand);
  return { ...queue, shuffle: true, shuffleOrder: order };
}

/** After inserting `count` items at `at`, shift play-order indices >= `at`. */
function remapOrder(order: number[], _oldLength: number, at: number, count: number): number[] {
  return order.map((i) => (i >= at ? i + count : i));
}
