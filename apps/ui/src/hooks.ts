import { useEffect, useState } from 'react';
import { useStore } from 'zustand/react';
import { session } from './app';
import type { UiState } from './store';

/** Subscribe to the UI store. */
export function useUi<T>(selector: (s: UiState) => T): T {
  return useStore(session.store, selector);
}

const QUERY = '(prefers-reduced-motion: reduce)';

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => (typeof matchMedia !== 'undefined' ? matchMedia(QUERY).matches : false));
  useEffect(() => {
    const mq = matchMedia(QUERY);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** Position of the playhead right now, interpolated between coordinator events. */
export function positionNow(): number {
  const c = session.runtime.clock;
  const pos = c.playing ? c.positionMs + (Date.now() - c.atMs) : c.positionMs;
  return c.durationMs > 0 ? Math.min(pos, c.durationMs) : Math.max(0, pos);
}
