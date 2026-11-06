import { useUi } from '../hooks';
import { Lyrics } from './Lyrics';
import './lyrics.css';

/** Right-hand lyrics column beside the browse stage, toggled from the top bar. */
export function LyricsRail() {
  const track = useUi((s) => s.snapshot.current?.track);
  if (!track) return null;
  return (
    <aside className="lyrics-rail" aria-label={`Lyrics for ${track.title}`}>
      <Lyrics key={track.id} raw={track.lyrics} />
    </aside>
  );
}
