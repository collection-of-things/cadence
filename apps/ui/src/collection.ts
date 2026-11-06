import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand/react';
import type { LibraryAlbum, TrackRef } from '@cadence/protocol';

/**
 * Renderer-local collection: pinned albums, favourite songs and recently
 * played albums. Persisted to localStorage (versioned key); there is no
 * engine API for these yet, so nothing here leaves the renderer.
 */
export interface CollectionState {
  pins: LibraryAlbum[];
  favorites: TrackRef[];
  /** Album keys (`title\u0000artist`), most recent first. */
  recent: string[];
}

const KEY = 'cadence.collection.v1';
const RECENT_MAX = 20;

export const albumKey = (title: string, artist: string) => `${title}\u0000${artist}`;

function load(): CollectionState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<CollectionState>;
      return { pins: parsed.pins ?? [], favorites: parsed.favorites ?? [], recent: parsed.recent ?? [] };
    }
  } catch {
    // Storage blocked or corrupt — start empty.
  }
  return { pins: [], favorites: [], recent: [] };
}

export const collection = createStore<CollectionState>(() => load());

collection.subscribe((state) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Quota or blocked storage: the collection still works for this session.
  }
});

export function useCollection<T>(selector: (s: CollectionState) => T): T {
  return useStore(collection, selector);
}

export function togglePin(album: LibraryAlbum): void {
  const { pins } = collection.getState();
  collection.setState({
    pins: pins.some((p) => p.id === album.id) ? pins.filter((p) => p.id !== album.id) : [...pins, album],
  });
}

export function toggleFavorite(track: TrackRef): void {
  const { favorites } = collection.getState();
  if (favorites.some((t) => t.id === track.id)) {
    collection.setState({ favorites: favorites.filter((t) => t.id !== track.id) });
    return;
  }
  collection.setState({ favorites: [track, ...favorites] });
}

export function recordPlayed(track: TrackRef): void {
  const artist = track.artists[0]?.name;
  if (!track.album || !artist) return;
  const key = albumKey(track.album, artist);
  const { recent } = collection.getState();
  if (recent[0] === key) return;
  collection.setState({ recent: [key, ...recent.filter((k) => k !== key)].slice(0, RECENT_MAX) });
}
