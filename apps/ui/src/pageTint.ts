import { useEffect, useMemo, useSyncExternalStore, type CSSProperties } from 'react';
import { useArtworkPalette } from './palette';
import { accentRgb, usePrefs } from './prefs';
import { pageTheme } from './theme';

/**
 * The open page's cover colours (from pageTheme in theme.ts). An album or
 * playlist page publishes them; the shell paints them behind the whole
 * window, so the sidebar and side panel glass pick the colour up too.
 */
interface TintState {
  /** True while a page with a cover is open. */
  active: boolean;
  /** The last published colours, kept after the page closes so the wash can fade out. */
  style: CSSProperties | null;
}
let state: TintState = { active: false, style: null };
const listeners = new Set<() => void>();

function setPageTint(next: CSSProperties | null): void {
  state = next ? { active: true, style: next } : { active: false, style: state.style };
  listeners.forEach((listener) => listener());
}

/** The page tint and whether a page with a cover is open now. */
export function usePageTint(): TintState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/** Publish this page's tint while it is mounted. Pass a style with a stable identity. */
export function usePublishPageTint(style: CSSProperties): void {
  useEffect(() => {
    setPageTint(style);
    return () => setPageTint(null);
  }, [style]);
}

/**
 * The colours an album or playlist page wears, taken from its cover. Returns
 * the style for the page root and publishes the same tint to the shell.
 */
export function useCoverTheme(artworkUrl: string | undefined): CSSProperties {
  const palette = useArtworkPalette(artworkUrl);
  const accent = usePrefs((p) => p.accent);
  const style = useMemo(() => pageTheme(palette, accentRgb(accent)), [palette, accent]);
  usePublishPageTint(style);
  return style;
}
