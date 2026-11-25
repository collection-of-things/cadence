import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion, useUi } from '../hooks';
import { session } from '../session';
import { TOAST_MS } from '../store';
import { CloseIcon } from '../icons';
import { RouteBadge } from './RouteBadge';
import './controls.css';

/** How long a dismissed toast takes to leave; matches `.toast.is-leaving`. */
const EXIT_MS = 180;
/** A toast starts leaving here, just before the store drops it, so a
 *  timed-out toast sinks away like a dismissed one instead of vanishing. */
const AUTO_LEAVE_MS = TOAST_MS - EXIT_MS - 40;

/**
 * Route notices, bottom-left over the stage. They rise in from the bottom
 * edge and, when dismissed, sink back out the same way.
 */
export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const [leaving, setLeaving] = useState<ReadonlySet<number>>(new Set());
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const live = new Set(toasts.map((t) => t.id));
    for (const t of toasts) {
      if (timers.current.has(t.id)) continue;
      timers.current.set(t.id, setTimeout(() => setLeaving((set) => new Set(set).add(t.id)), AUTO_LEAVE_MS));
    }
    for (const [id, timer] of timers.current) {
      if (live.has(id)) continue;
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, [toasts]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  if (!toasts.length) return null;

  const dismiss = (id: number) => {
    if (prefersReducedMotion()) {
      session.dismissToast(id);
      return;
    }
    setLeaving((set) => new Set(set).add(id));
    setTimeout(() => {
      session.dismissToast(id);
      setLeaving((set) => {
        const next = new Set(set);
        next.delete(id);
        return next;
      });
    }, EXIT_MS);
  };

  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${leaving.has(t.id) ? 'is-leaving' : ''}`} role="status">
          <RouteBadge route={t.route} />
          <span className="toast-msg">
            {t.message}
            {t.retriable && <em> Try again.</em>}
          </span>
          <button className="icon-btn" aria-label="Dismiss" disabled={leaving.has(t.id)} onClick={() => dismiss(t.id)}>
            <CloseIcon size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
