import { useEffect, useState } from 'react';
import type { TrackRef } from '@cadence/protocol';
import { cleanIpcError } from '../ipcError';
import { api, session } from '../session';

/** Lyrics for one track, plus the tools a local file gets. */
export interface TrackLyrics {
  /** Raw text: LRC when synced, otherwise plain. */
  text: string | undefined;
  /** The listener's sync nudge, added to every line's time. */
  offsetMs: number;
  /** Local files only: attach a downloaded lyrics file and nudge its timing. */
  tools?: {
    importFile(): void;
    setOffset(offsetMs: number): void;
  };
}

type Loaded = { id: string; text: string | undefined; offsetMs: number };

const loadedFrom = (track: TrackRef): Loaded => ({ id: track.id, text: track.lyrics, offsetMs: track.lyricsOffsetMs ?? 0 });

/**
 * Lyrics for the given track. Provider tracks carry none on the TrackRef, so
 * they are fetched on demand. Local files are re-read from the library, since
 * the queue's copy predates a lyrics file added or nudged after it was queued.
 */
export function useTrackLyrics(track: TrackRef | undefined): TrackLyrics {
  const [loaded, setLoaded] = useState<Loaded>();
  const id = track?.id;
  const isFile = track?.source.kind === 'file';
  // Library items carry their catalog twin for lookups keyed by catalog id.
  const catalogId = track?.source.kind === 'provider' ? (track.source.catalogId ?? track.source.providerItemId) : undefined;
  const route = track?.route;
  const hasOwnLyrics = Boolean(track?.lyrics);

  useEffect(() => {
    if (!id || !route) return;
    let live = true;
    if (isFile) {
      api.library
        .track(id)
        .then((fresh) => {
          if (live && fresh) setLoaded(loadedFrom(fresh));
        })
        .catch(() => undefined);
    } else if (!hasOwnLyrics && catalogId && api.catalog) {
      api.catalog
        .query(route, { kind: 'lyrics', songId: catalogId })
        .then((page) => {
          if (live && page.lyrics) setLoaded({ id, text: page.lyrics, offsetMs: 0 });
        })
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [id, route, isFile, catalogId, hasOwnLyrics]);

  // A result for another track is stale; fall back to what the queue carries.
  const current = track && loaded?.id === track.id ? loaded : track ? loadedFrom(track) : undefined;
  if (!track || !current) return { text: undefined, offsetMs: 0 };
  if (!isFile) return { text: current.text, offsetMs: 0 };

  const report = (e: unknown) => session.showToast('local', cleanIpcError(e, 'Lyrics could not be saved'), false);
  return {
    text: current.text,
    offsetMs: current.offsetMs,
    tools: {
      importFile: () => {
        api.library
          .importLyrics(track.id)
          .then((fresh) => {
            if (fresh) setLoaded(loadedFrom(fresh));
          })
          .catch(report);
      },
      setOffset: (offsetMs) => {
        // Shown at once, so repeated nudges build on each other.
        setLoaded({ ...current, offsetMs });
        api.library.setLyricsOffset(track.id, offsetMs).catch(report);
      },
    },
  };
}
