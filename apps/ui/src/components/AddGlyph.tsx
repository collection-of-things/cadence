import { useEffect, useRef, useState } from 'react';
import { CheckIcon, PlusIcon } from '../icons';

/**
 * Completion feedback for "add to queue" buttons: call `flash()` after
 * queueing and `added` stays true for a moment, so the plus can turn into
 * a check.
 */
export function useJustAdded(ms = 1200): { added: boolean; flash(): void } {
  const [added, setAdded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const flash = () => {
    if (timer.current) clearTimeout(timer.current);
    setAdded(true);
    timer.current = setTimeout(() => setAdded(false), ms);
  };
  return { added, flash };
}

/** Plus glyph that swaps to an accent check while `added`. */
export function AddGlyph({ added, size = 16 }: { added: boolean; size?: number }) {
  return (
    <span className={`add-glyph ${added ? 'is-added' : ''}`} key={added ? 'added' : 'add'}>
      {added ? <CheckIcon size={size} /> : <PlusIcon size={size} />}
    </span>
  );
}
