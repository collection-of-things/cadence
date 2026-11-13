import { useCallback, useReducer } from 'react';
import type { CatalogArtist, CatalogContainer, LibraryAlbum } from '@cadence/protocol';

export type LibraryTab = 'albums' | 'artists' | 'songs';
export type SettingsSection = 'accounts' | 'library' | 'audio' | 'player' | 'appearance' | 'phone' | 'about';

/**
 * Where the browse stage is. The now-playing overlay is not a location.
 * A search typed in the top bar rides the location as `query`; `nonce`
 * marks each submission so a repeated query still reaches the page.
 */
export type Location =
  | { page: 'home' }
  | { page: 'browse' }
  | { page: 'radio' }
  | { page: 'search'; query?: string; nonce?: number }
  | { page: 'library'; tab: LibraryTab; query?: string; nonce?: number }
  | { page: 'localfiles'; tab: LibraryTab }
  | { page: 'favorites' }
  | { page: 'sources' }
  | { page: 'settings'; section: SettingsSection }
  | { page: 'album'; album: LibraryAlbum }
  /** An artist in the local library, by name. */
  | { page: 'localartist'; name: string }
  | { page: 'detail'; container: CatalogContainer }
  | { page: 'artist'; artist: CatalogArtist };

/** True when two locations show the same page, so navigating between them adds no history. */
export function sameLocation(a: Location, b: Location): boolean {
  if (a.page !== b.page) return false;
  if (a.page === 'search' && b.page === 'search') return a.query === b.query;
  if (a.page === 'library' && b.page === 'library') return a.tab === b.tab;
  if (a.page === 'localfiles' && b.page === 'localfiles') return a.tab === b.tab;
  if (a.page === 'settings' && b.page === 'settings') return a.section === b.section;
  if (a.page === 'album' && b.page === 'album') return a.album.id === b.album.id;
  if (a.page === 'localartist' && b.page === 'localartist') return a.name === b.name;
  if (a.page === 'detail' && b.page === 'detail') return a.container.id === b.container.id;
  if (a.page === 'artist' && b.page === 'artist') return a.artist.id === b.artist.id;
  return true;
}

/**
 * Identity of a location for page-change animation (a new key re-mounts the
 * page). Library tabs share one key: search can switch tabs while typing,
 * and a remount would drop the query and focus. Settings sections share one
 * too, so switching section swaps the controls without replaying the page.
 */
export function pageKey(location: Location): string {
  if (location.page === 'album') return `album:${location.album.id}`;
  if (location.page === 'localartist') return `localartist:${location.name}`;
  if (location.page === 'detail') return `detail:${location.container.id}`;
  if (location.page === 'artist') return `artist:${location.artist.id}`;
  return location.page;
}

export interface History {
  location: Location;
  back: Location[];
  forward: Location[];
  /** Search submissions so far; the latest one stamps `nonce`. */
  submissions: number;
}

export type HistoryAction = { kind: 'navigate'; to: Location } | { kind: 'back' } | { kind: 'forward' };

export const INITIAL_HISTORY: History = { location: { page: 'home' }, back: [], forward: [], submissions: 0 };

/** A location that carries a typed search, so every navigation to it must land. */
function isSubmission(to: Location): to is Extract<Location, { page: 'search' | 'library' }> {
  return to.page === 'search' || (to.page === 'library' && to.query !== undefined);
}

/**
 * Back/forward history. Navigating to the page already shown changes nothing;
 * switching Settings section updates the current entry.
 */
export function historyReducer(history: History, action: HistoryAction): History {
  const { location, back, forward } = history;
  switch (action.kind) {
    case 'navigate': {
      const moved = !sameLocation(action.to, location);
      if (isSubmission(action.to)) {
        // A repeat of the current query updates in place: the page resets its
        // field to what was submitted and the back stack does not grow.
        const submissions = history.submissions + 1;
        const target = { ...action.to, nonce: submissions };
        return moved
          ? { location: target, back: [...back, location], forward: [], submissions }
          : { ...history, location: target, submissions };
      }
      if (!moved) return history;
      // Settings sections replace each other in place, so Back and Close
      // settings leave Settings in one step.
      if (action.to.page === 'settings' && location.page === 'settings') return { ...history, location: action.to };
      return { ...history, location: action.to, back: [...back, location], forward: [] };
    }
    case 'back': {
      const previous = back.at(-1);
      if (!previous) return history;
      return { ...history, location: previous, back: back.slice(0, -1), forward: [...forward, location] };
    }
    case 'forward': {
      const next = forward.at(-1);
      if (!next) return history;
      return { ...history, location: next, back: [...back, location], forward: forward.slice(0, -1) };
    }
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

export interface Navigation {
  location: Location;
  canGoBack: boolean;
  canGoForward: boolean;
  navigate(to: Location): void;
  goBack(): void;
  goForward(): void;
}

/** The shell's location and its back/forward history. */
export function useNavigation(): Navigation {
  const [history, dispatch] = useReducer(historyReducer, INITIAL_HISTORY);
  const navigate = useCallback((to: Location) => dispatch({ kind: 'navigate', to }), []);
  const goBack = useCallback(() => dispatch({ kind: 'back' }), []);
  const goForward = useCallback(() => dispatch({ kind: 'forward' }), []);
  return {
    location: history.location,
    canGoBack: history.back.length > 0,
    canGoForward: history.forward.length > 0,
    navigate,
    goBack,
    goForward,
  };
}
