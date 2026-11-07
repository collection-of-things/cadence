import { session } from '../session';
import { toggleFavorite, useCollection } from '../collection';
import { artistsLine } from '../format';
import { useUi } from '../hooks';
import { ExpandIcon, NoteIcon, QueueIcon, StarIcon } from '../icons';
import { SeekBar } from './SeekBar';
import { Transport, VolumeControl } from './Transport';
import './playerbar.css';

/**
 * Docked player at the bottom of the stage: artwork + metadata + favourite
 * on the left, seek over transport in the centre, volume and view toggles
 * on the right.
 */
export function PlayerBar({ onOpenNowPlaying }: { onOpenNowPlaying(): void }) {
  const track = useUi((s) => s.snapshot.current?.track);
  const queueOpen = useUi((s) => s.queueOpen);
  const favorite = useCollection((s) => (track ? s.favorites.some((t) => t.id === track.id) : false));
  const sub = track ? [track.album, artistsLine(track.artists)].filter(Boolean).join(' – ') : 'Pick something from your library';

  return (
    <footer className={`playerbar ${track ? '' : 'is-idle'}`} aria-label="Player">
      {/* pb-center leads DOM order so the transport is the first play-named
          control in the document; grid-area pins keep the visual layout. */}
      <div className="pb-center">
        <SeekBar />
        <Transport />
      </div>

      <div className="pb-left">
        <button className="pb-art" aria-label="Open now playing" title="Now playing" disabled={!track} onClick={onOpenNowPlaying}>
          {track?.artwork ? <img key={track.id} src={track.artwork.url} alt="" draggable={false} /> : <NoteIcon size={22} />}
        </button>
        <div className="pb-meta" key={track?.id ?? 'none'}>
          <span className="pb-title" title={track?.title}>{track?.title ?? 'Nothing playing'}</span>
          <span className="pb-sub" title={sub}>{sub}</span>
        </div>
        {track && (
          <button
            className={`ctl-btn pb-fav ${favorite ? 'is-on' : ''}`}
            aria-label={favorite ? 'Remove from Favourite Songs' : 'Add to Favourite Songs'}
            aria-pressed={favorite}
            title={favorite ? 'Favourited' : 'Favourite'}
            onClick={() => toggleFavorite(track)}
          >
            <StarIcon size={19} filled={favorite} />
          </button>
        )}
      </div>

      <div className="pb-right">
        <VolumeControl />
        <button
          className={`ctl-btn ${queueOpen ? 'is-on' : ''}`}
          aria-label="Queue"
          aria-pressed={queueOpen}
          title="Queue (Q)"
          data-queue-toggle
          onClick={() => session.setQueueOpen(!queueOpen)}
        >
          <QueueIcon size={19} />
        </button>
        <button className="ctl-btn" aria-label="Full screen player" title="Full screen" disabled={!track} onClick={onOpenNowPlaying}>
          <ExpandIcon size={18} />
        </button>
      </div>
    </footer>
  );
}
