import { useState } from 'react';
import { useUi } from '../hooks';
import { session } from '../session';
import { CloseIcon } from '../icons';
import { providerForRoute, RouteBadge } from './RouteBadge';
import './controls.css';

/** How long a dismissed toast takes to leave; matches `.toast.is-leaving`. */
const EXIT_MS = 180;

/**
 * Route notices, bottom-left over the stage. They rise in from the bottom
 * edge and, when dismissed, sink back out the same way.
 */
export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const [leaving, setLeaving] = useState<ReadonlySet<number>>(new Set());
  if (!toasts.length) return null;

  const dismiss = (id: number) => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
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
          <RouteBadge provider={providerForRoute(t.route)} title={t.route} />
          <span className="toast-msg">
            {t.message}
            {t.retriable && <em> — try again</em>}
          </span>
          <button className="icon-btn" aria-label="Dismiss" disabled={leaving.has(t.id)} onClick={() => dismiss(t.id)}>
            <CloseIcon size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
