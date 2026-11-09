import { useState } from 'react';
import { useUi } from '../hooks';
import { Lyrics } from './Lyrics';
import { useTrackLyrics } from './useTrackLyrics';
import './lyrics.css';

/** Right-hand lyrics panel beside the stage, toggled from the player (L). */
export function LyricsRail() {
  const track = useUi((s) => s.snapshot.current?.track);
  const lyrics = useTrackLyrics(track);
  // Opened with the L key: appear at once (see instant.ts).
  const [instant] = useState(() => document.documentElement.dataset.instant !== undefined);
  if (!track) return null;
  return (
    <aside className={`lyrics-rail ${instant ? 'is-instant' : ''}`} aria-label={`Lyrics for ${track.title}`}>
      <Lyrics key={track.id} raw={lyrics} />
    </aside>
  );
}
