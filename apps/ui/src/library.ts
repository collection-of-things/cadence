import { useEffect, useState } from 'react';
import type { LibraryAlbum } from '@cadence/protocol';
import { useUi } from './hooks';
import { api, session } from './session';

/**
 * Read from the local library. Null until the first read lands; `empty` if a
 * read fails. Reads again when `deps` change or a scan starts or finishes,
 * and keeps the last result on screen while the new one loads.
 */
export function useLibraryRead<T>(read: () => Promise<T>, deps: readonly unknown[], empty: T): T | null {
  const [data, setData] = useState<T | null>(null);
  const scanPhase = useUi((s) => s.scan.phase);
  useEffect(() => {
    let live = true;
    read()
      .then((result) => live && setData(result))
      .catch(() => live && setData(empty));
    return () => {
      live = false;
    };
    // `read` and `empty` are new values every render; `deps` says when to read again.
  }, [scanPhase, ...deps]);
  return data;
}

/** Replace the queue with a local album and start it. */
export async function playAlbum(album: LibraryAlbum): Promise<void> {
  const tracks = await api.library.tracks({ album: album.title, artist: album.artist });
  session.playTracks(tracks, 0, { kind: 'album', id: album.id, name: album.title });
}
