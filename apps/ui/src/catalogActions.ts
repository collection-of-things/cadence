import { useState, useSyncExternalStore } from 'react';
import type { CatalogContainer, RouteId, TrackRef } from '@cadence/protocol';
import type { CatalogNav } from './components/provider/catalog';
import { cleanIpcError } from './ipcError';
import { routeState } from './routes';
import { useUi } from './hooks';
import { api, session } from './session';

type LibraryCollection = 'songs' | 'albums' | 'playlists';

/** What "Add to Library" can do for an item. */
export type LibraryTarget =
  | { kind: 'saved' }
  | { kind: 'addable'; route: RouteId; collection: LibraryCollection; id: string }
  | { kind: 'none' };

/** A track from the user's library is saved; a catalog song can be added; others can't. */
export function targetForTrack(track: TrackRef): LibraryTarget {
  const { source } = track;
  if (source.kind !== 'provider') return { kind: 'none' };
  if (source.uri?.startsWith('am:library-song:')) return { kind: 'saved' };
  if (source.uri?.startsWith('am:song:')) return { kind: 'addable', route: track.route, collection: 'songs', id: source.providerItemId };
  return { kind: 'none' };
}

export function targetForContainer(container: CatalogContainer): LibraryTarget {
  if (container.isLibraryItem) return { kind: 'saved' };
  return { kind: 'addable', route: container.route, collection: container.kind === 'album' ? 'albums' : 'playlists', id: container.id };
}

// Items saved since launch. Apple doesn't say whether a catalog item is already
// in the library, so this is how a button remembers it was just pressed.
const savedThisSession = new Set<string>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export type LibrarySaveState = 'hidden' | 'ready' | 'busy' | 'saved';

/** State and action behind every "Add to Library" control. Hidden when signed out. */
export function useLibrarySave(target: LibraryTarget): { state: LibrarySaveState; add(): void } {
  const [busy, setBusy] = useState(false);
  const key = target.kind === 'addable' ? `${target.route}:${target.collection}:${target.id}` : null;
  const justSaved = useSyncExternalStore(subscribe, () => key !== null && savedThisSession.has(key));
  const signedIn = useUi((s) => target.kind === 'addable' && routeState(s, target.route) === 'ready');

  const state: LibrarySaveState =
    target.kind === 'saved' || justSaved ? 'saved'
    : target.kind === 'none' || !signedIn ? 'hidden'
    : busy ? 'busy'
    : 'ready';

  const add = () => {
    if (state !== 'ready' || target.kind !== 'addable' || key === null || !api.catalog) return;
    setBusy(true);
    api.catalog
      .query(target.route, { kind: 'addToLibrary', ids: { [target.collection]: [target.id] } })
      .then(() => {
        savedThisSession.add(key);
        listeners.forEach((listener) => listener());
      })
      .catch((e: unknown) => session.showToast(target.route, cleanIpcError(e), true))
      .finally(() => setBusy(false));
  };

  return { state, add };
}

/** The catalog id "Go to Album/Artist" looks up, when the track has one. */
export function catalogSongId(track: TrackRef): string | undefined {
  const { source } = track;
  if (source.kind !== 'provider') return undefined;
  if (source.catalogId) return source.catalogId;
  return source.uri?.startsWith('am:song:') ? source.providerItemId : undefined;
}

/** Looks up a song's album or artist and opens that page. */
export function openSongLink({ route, songId, link, nav }: {
  route: RouteId;
  songId: string;
  link: 'album' | 'artist';
  nav: CatalogNav;
}): void {
  if (!api.catalog) return;
  api.catalog
    .query(route, { kind: 'songLinks', songId })
    .then((page) => {
      for (const entry of page.sections.flatMap((s) => s.entries)) {
        if (link === 'album' && entry.kind === 'album') return nav.openAlbum(entry.album);
        if (link === 'artist' && entry.kind === 'artist') return nav.openArtist(entry.artist);
      }
      session.showToast(route, `Couldn't find this song's ${link}`, false);
    })
    .catch((e: unknown) => session.showToast(route, cleanIpcError(e), true));
}
