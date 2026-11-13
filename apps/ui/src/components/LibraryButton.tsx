import { useLibrarySave, type LibraryTarget } from '../catalogActions';
import { LibraryIcon } from '../icons';

/**
 * "Add to Library" icon button; the host picks its look with `className`.
 * Apple Music can't remove items through its API, so a saved item stays ticked.
 */
export function LibraryButton({ target, className, size }: { target: LibraryTarget; className: string; size: number }) {
  const { state, add } = useLibrarySave(target);
  if (state === 'hidden') return null;
  const saved = state === 'saved';
  const label = saved ? 'In your library' : 'Add to Library';
  return (
    <button
      className={`${className} ${saved ? 'is-on' : ''}`}
      aria-label={label}
      aria-disabled={saved}
      title={label}
      disabled={state === 'busy'}
      onClick={add}
    >
      <LibraryIcon saved={saved} size={size} />
    </button>
  );
}
