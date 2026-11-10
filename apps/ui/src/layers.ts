import { useEffect, useRef } from 'react';

/**
 * Surfaces that sit over the page and close on Escape. A higher rank wins
 * the key; within a rank, the one opened last wins.
 */
const RANK = { nowPlaying: 1, queue: 2, menu: 3 } as const;
export type LayerKind = keyof typeof RANK;

interface Layer {
  kind: LayerKind;
  onEscape(): void;
}

const open: Layer[] = [];

/** The layer that owns Escape right now. */
function topLayer(): Layer | undefined {
  return open.reduce<Layer | undefined>((top, layer) => (top && RANK[top.kind] > RANK[layer.kind] ? top : layer), undefined);
}

// Bubble phase on the document: a focused field that handles Escape itself
// (and stops it) keeps the key; otherwise the top layer closes.
function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  const top = topLayer();
  if (!top) return;
  event.stopImmediatePropagation();
  top.onEscape();
}

/**
 * Register an open surface while `active`. Escape goes to the top layer
 * only, so two surfaces never close on one key press.
 */
export function useEscapeLayer(kind: LayerKind, active: boolean, onEscape: () => void): void {
  const latest = useRef(onEscape);
  latest.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const layer: Layer = { kind, onEscape: () => latest.current() };
    if (open.length === 0) document.addEventListener('keydown', onKeyDown);
    open.push(layer);
    return () => {
      open.splice(open.indexOf(layer), 1);
      if (open.length === 0) document.removeEventListener('keydown', onKeyDown);
    };
  }, [kind, active]);
}
