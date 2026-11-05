import { useUi } from '../hooks';
import { session } from '../app';
import { CloseIcon } from '../icons';
import { providerForRoute, RouteBadge } from './RouteBadge';
import './controls.css';

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  if (!toasts.length) return null;
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast" role="status">
          <RouteBadge provider={providerForRoute(t.route)} title={t.route} />
          <span className="toast-msg">
            {t.message}
            {t.retriable && <em> — try again</em>}
          </span>
          <button className="icon-btn" aria-label="Dismiss" onClick={() => session.dismissToast(t.id)}>
            <CloseIcon size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
