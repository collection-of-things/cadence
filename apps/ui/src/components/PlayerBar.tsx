import { useRef } from 'react';
import type { TrackRef } from '@cadence/protocol';
import { session } from '../session';
import { targetForTrack } from '../catalogActions';
import { toggleFavorite, useCollection } from '../collection';
import { artistsLine } from '../format';
import { useUi } from '../hooks';
import { CollapseIcon, ExpandIcon, LyricsIcon, NoteIcon, QueueIcon, StarIcon } from '../icons';
import { LibraryButton } from './LibraryButton';
import { providerForRoute, RouteBadge } from './RouteBadge';
import { SeekBar, TimeReadout } from './SeekBar';
import { Transport, VolumeControl } from './Transport';
import './playerbar.css';

/** "is-swap" once the track changes after mount, so only real track changes animate. */
function useSwapClass(trackId: string | undefined): string {
  const first = useRef(trackId);
  return trackId !== undefined && trackId !== first.current ? 'is-swap' : '';
}

function FavoriteButton({ track }: { track: TrackRef }) {
  const favorite = useCollection((s) => s.favorites.some((t) => t.id === track.id));
  return (
    <button
      className={`ctl-btn pb-fav ${favorite ? 'is-on' : ''}`}
      aria-label={favorite ? 'Remove from Favourite Songs' : 'Add to Favourite Songs'}
      aria-pressed={favorite}
      title={favorite ? 'Favourited' : 'Favourite'}
      onClick={() => toggleFavorite(track)}
    >
      <StarIcon size={17} filled={favorite} />
    </button>
  );
}

function QueueButton() {
  const queueOpen = useUi((s) => s.queueOpen);
  return (
    <button
      className={`ctl-btn ${queueOpen ? 'is-on' : ''}`}
      aria-label="Queue"
      aria-pressed={queueOpen}
      title="Queue (Q)"
      data-queue-toggle
      onClick={() => session.setQueueOpen(!queueOpen)}
    >
      <QueueIcon size={18} />
    </button>
  );
}

interface PlayerBarProps {
  /** `docked` is a card on the bottom edge of a page; `floating` hovers over Now Playing. */
  placement: 'docked' | 'floating';
  lyricsOn: boolean;
  onToggleLyrics(): void;
  /** Opens Now Playing from a docked bar and leaves it from a floating one. */
  onToggleFullScreen(): void;
}

/**
 * The one player on every screen, in three columns: artwork, title and
 * save actions; the seek line above the transport; then volume, lyrics,
 * queue (the side panel's tab order) and full screen. The transport leads DOM order so it is the first
 * play-named control in the document; the grid places it visually.
 */
export function PlayerBar({ placement, lyricsOn, onToggleLyrics, onToggleFullScreen }: PlayerBarProps) {
  const track = useUi((s) => s.snapshot.current?.track);
  const paused = useUi((s) => s.snapshot.status !== 'playing');
  const swap = useSwapClass(track?.id);
  const docked = placement === 'docked';
  const sub = track ? [track.album, artistsLine(track.artists)].filter(Boolean).join(' – ') : 'Pick something to play';
  const metaKey = track?.id ?? 'none';
  const art = track?.artwork?.url;
  const nowPlaying = (
    <>
      <span className="pb-art">{art ? <img src={art} alt="" draggable={false} /> : <NoteIcon size={22} />}</span>
      <span className="pb-meta">
        <span className="pb-title" title={track?.title}>{track?.title ?? 'Nothing playing'}</span>
        <span className="pb-sub" title={track ? sub : undefined}>{sub}</span>
      </span>
    </>
  );

  return (
    <footer className={`playerbar is-${placement} ${track ? '' : 'is-idle'} ${paused ? 'is-paused' : ''}`} aria-label="Player">
      <Transport />
      <div className="pb-seek">
        <TimeReadout part="elapsed" />
        <SeekBar />
        <TimeReadout part="remaining" />
      </div>
      <div className="pb-now">
        {docked ? (
          <button key={metaKey} className={`pb-open ${swap}`} aria-label="Open now playing" title="Now playing" disabled={!track} onClick={onToggleFullScreen}>
            {nowPlaying}
          </button>
        ) : (
          <div key={metaKey} className={`pb-open ${swap}`}>{nowPlaying}</div>
        )}
        {track && <LibraryButton target={targetForTrack(track)} className="ctl-btn pb-fav" size={17} />}
        {track && <FavoriteButton track={track} />}
        {track && <RouteBadge provider={providerForRoute(track.route)} title={`Route: ${track.route}`} />}
      </div>
      <div className="pb-right">
        <VolumeControl />
        <button className={`ctl-btn ${lyricsOn ? 'is-on' : ''}`} aria-label="Lyrics" aria-pressed={lyricsOn} title={docked ? 'Lyrics (L)' : 'Lyrics'} disabled={!track} onClick={onToggleLyrics}>
          <LyricsIcon size={18} />
        </button>
        <QueueButton />
        <button
          className="ctl-btn"
          aria-label={docked ? 'Full screen player' : 'Exit full screen'}
          title={docked ? 'Full screen' : 'Exit full screen (Esc)'}
          disabled={!track}
          onClick={onToggleFullScreen}
        >
          {docked ? <ExpandIcon size={17} /> : <CollapseIcon size={17} />}
        </button>
      </div>
    </footer>
  );
}
