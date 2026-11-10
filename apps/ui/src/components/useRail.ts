import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

interface Rail {
  railRef: RefObject<HTMLDivElement>;
  /** True when the rail sits at that end, so its arrow has nowhere to go. */
  edges: { start: boolean; end: boolean };
  /** Attach to the rail's onScroll. */
  onScroll(): void;
  /** Scroll by the cards in view, less one so the eye keeps its place. */
  step(direction: -1 | 1): void;
}

/**
 * Scroll state and arrow stepping for a horizontal card rail. `content` is
 * whatever the rail renders; the edges are measured again when it changes or
 * the rail resizes (window, sidebar or side panel).
 */
export function useRail(content: unknown): Rail {
  const railRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const measure = useCallback(() => {
    const el = railRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ start: el.scrollLeft <= 2, end: el.scrollLeft >= max - 2 });
  }, []);

  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, content]);

  const step = (direction: -1 | 1) => {
    const el = railRef.current;
    if (!el) return;
    const card = el.firstElementChild;
    const width = card instanceof HTMLElement ? card.offsetWidth + 16 : 240;
    const visible = Math.max(1, Math.floor(el.clientWidth / width) - 1);
    el.scrollBy({ left: direction * visible * width, behavior: 'smooth' });
  };

  return { railRef, edges, onScroll: measure, step };
}
