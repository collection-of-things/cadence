import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { TrackRef } from '@cadence/protocol';
import { session } from '../session';
import { toggleFavorite, useCollection } from '../collection';
import { artistsLine, formatTime } from '../format';
import { useUi } from '../hooks';
import { MoreIcon, NoteIcon, PlayIcon, StarIcon } from '../icons';

/** Animated level bars marking the playing row. Static when paused. */
export function NowBars({ playing }: { playing: boolean }) {
  return (
    <span className={`now-bars ${playing ? 'is-playing' : ''}`} aria-hidden="true">
      <i /><i /><i /><i />
    </span>
  );
}

/** "…" button with play-next / queue / favourite actions for one track. */
export function TrackMenu({ track }: { track: TrackRef }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const favorite = useCollection((s) => s.favorites.some((t) => t.id === track.id));

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        ref.current?.querySelector<HTMLElement>('.row-more')?.focus();
      }
    };
    document.addEventListener('pointerdown', away);
    window.addEventListener('keydown', key, true);
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);

  const act = (fn: () => void) => () => {
    fn();
    setOpen(false);
    ref.current?.querySelector<HTMLElement>('.row-more')?.focus();
  };

  return (
    <div className="row-menu" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button
        className="row-more"
        aria-label={`More actions for ${track.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <MoreIcon size={18} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={act(() => session.insertNext(track))}>Play next</button>
          <button role="menuitem" onClick={act(() => session.append(track))}>Add to queue</button>
          <button role="menuitem" onClick={act(() => toggleFavorite(track))}>
            {favorite ? 'Remove from Favourite Songs' : 'Add to Favourite Songs'}
          </button>
        </div>
      )}
    </div>
  );
}

interface TrackRowProps {
  track: TrackRef;
  index: number;
  /** 'album' shows number, title, duration. 'list' adds art, artist, album. */
  variant: 'album' | 'list';
  /** Hide the artist line when it repeats the album artist. */
  albumArtist?: string;
  onPlay(): void;
}

/** One track as a rounded row card; the playing track fills with the accent. */
export function TrackRow({ track, index, variant, albumArtist, onPlay }: TrackRowProps) {
  const isCurrent = useUi((s) => s.snapshot.current?.track.id === track.id);
  const playing = useUi((s) => s.snapshot.status === 'playing') && isCurrent;
  const favorite = useCollection((s) => s.favorites.some((t) => t.id === track.id));
  const artists = artistsLine(track.artists);
  const unavailable = track.availability === 'unavailable';

  return (
    <div
      className={`track-row track-row-${variant} ${isCurrent ? 'is-current' : ''} ${unavailable ? 'is-off' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`Play ${track.title} by ${artists}`}
      aria-current={isCurrent || undefined}
      title={unavailable ? track.availabilityDetail ?? 'Unavailable' : undefined}
      style={{ '--i': index } as CSSProperties}
      onClick={onPlay}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onPlay();
        }
      }}
    >
      <span className="tr-index">
        {isCurrent ? <NowBars playing={playing} /> : <span className="tr-num">{index + 1}</span>}
        {!isCurrent && <span className="tr-play" aria-hidden="true"><PlayIcon size={15} /></span>}
      </span>
      {variant === 'list' && (
        <span className="tr-art">
          {track.artwork ? <img src={track.artwork.url} alt="" loading="lazy" /> : <NoteIcon size={18} />}
        </span>
      )}
      <span className="tr-main">
        <span className="tr-title">
          <span className="tr-title-text">{track.title}</span>
          {favorite && <span className="tr-fav" aria-label="Favourite"><StarIcon size={13} filled /></span>}
        </span>
        {variant === 'album' && albumArtist && artists !== albumArtist && <span className="tr-sub">{artists}</span>}
      </span>
      {variant === 'list' && <span className="tr-col tr-artist">{artists}</span>}
      {variant === 'list' && <span className="tr-col tr-album">{track.album ?? ''}</span>}
      <span className="tr-time">{formatTime(track.durationMs)}</span>
      <TrackMenu track={track} />
    </div>
  );
}
