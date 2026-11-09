import { useCallback, useLayoutEffect, useState } from 'react';

const KEY = 'cadence.sidebar-open.v1';

function readStored(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'false';
  } catch {
    return true;
  }
}

/**
 * Whether the left sidebar shows, remembered between launches. Mirrored onto
 * <html data-sidebar> so the shell and portals (toasts) lay out against it.
 */
export function useSidebarOpen(): { open: boolean; toggle(): void } {
  const [open, setOpen] = useState(readStored);

  useLayoutEffect(() => {
    document.documentElement.dataset.sidebar = open ? 'open' : 'hidden';
    try {
      localStorage.setItem(KEY, String(open));
    } catch {
      // Storage can be unavailable; the toggle still works for this session.
    }
  }, [open]);

  const toggle = useCallback(() => setOpen((current) => !current), []);
  return { open, toggle };
}
