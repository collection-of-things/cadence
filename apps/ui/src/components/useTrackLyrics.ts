import { useEffect, useState } from 'react';
import type { TrackRef } from '@cadence/protocol';
import { api } from '../session';

/** Provider tracks carry no lyrics on the TrackRef — fetch on demand. */
export function useTrackLyrics(track: TrackRef | undefined): string | undefined {
  const [lyrics, setLyrics] = useState<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setLyrics(undefined);
    if (!track || track.lyrics || !api.catalog) return;
    if (track.source.kind !== 'provider' || !track.source.providerItemId) return;
    // Library items carry their catalog twin for lookups keyed by catalog id.
    const id = track.source.catalogId ?? track.source.providerItemId;
    api.catalog
      .query(track.route, { kind: 'lyrics', songId: id })
      .then((page) => {
        if (live && page.lyrics) setLyrics(page.lyrics);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [track]);
  return track?.lyrics ?? lyrics;
}
