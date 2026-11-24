import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TrackRef } from '@cadence/protocol';
import { session } from '../session';
import { catalogSongId, openSongLink, targetForTrack, useLibrarySave } from '../catalogActions';
import { toggleFavorite, useCollection } from '../collection';
import { artistsLine, formatTime } from '../format';
import { useUi } from '../hooks';
import { useEscapeLayer } from '../layers';
import { MoreIcon, NoteIcon, PlayIcon, StarIcon } from '../icons';
import type { CatalogNav } from './provider/catalog';

/** Animated level bars marking the playing row. Static when paused. */
export function NowBars({ playing }: { playing: boolean }) {
  return (
    <span className={`now-bars ${playing ? 'is-playing' : ''}`} aria-hidden="true">
      <i /><i /><i /><i />
    </span>
  );
}

type MenuAction = (fn: () => void) => () => void;

/** Menu row for saving a streaming song; absent once saved or when signed out. */
function AddToLibraryItem({ track, act }: { track: TrackRef; act: MenuAction }) {
  const { state, add } = useLibrarySave(targetForTrack(track));
  if (state !== 'ready') return null;
  return <button role="menuitem" onClick={act(add)}>Add to Library</button>;
}

/**
 * "…" button with play-next / queue / library / favourite actions for one
 * track. Pass `nav` where the catalog pages exist to offer Go to Album/Artist.
 */
export function TrackMenu({ track, nav }: { track: TrackRef; nav?: CatalogNav | undefined }) {
  const [open, setOpen] = useState(false);
  // Opens on whichever side of the button has room between the top bar and
  // the docked player; when neither fits it takes the roomier side and scrolls.
  const [place, setPlace] = useState<{ up: boolean; maxHeight?: number }>({ up: false });
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const favorite = useCollection((s) => s.favorites.some((t) => t.id === track.id));

  useLayoutEffect(() => {
    if (!open) {
      setPlace({ up: false });
      return;
    }
    const menu = menuRef.current;
    const trigger = ref.current?.querySelector('.row-more')?.getBoundingClientRect();
    if (!menu || !trigger) return;
    const height = menu.scrollHeight;
    const player = document.querySelector('.playerbar.is-docked')?.getBoundingClientRect();
    const topbar = document.querySelector('.topbar')?.getBoundingClientRect();
    const floor = Math.min(player?.top ?? Infinity, window.innerHeight) - 8;
    const ceiling = (topbar?.bottom ?? 0) + 8;
    const below = floor - trigger.bottom - 6;
    const above = trigger.top - ceiling - 6;
    if (height <= below) return;
    if (height <= above) setPlace({ up: true });
    else setPlace(above > below ? { up: true, maxHeight: above } : { up: false, maxHeight: below });
  }, [open]);

  // The menu is anchored to its row: scrolling the row's own list or
  // resizing the window closes it (other panels scrolling, like synced
  // lyrics, leave it alone).
  useEffect(() => {
    if (!open) return;
    const scroller = ref.current?.closest('.tr-scroll, .stage-scroll');
    const close = () => setOpen(false);
    scroller?.addEventListener('scroll', close, { passive: true });
    window.addEventListener('resize', close);
    return () => {
      scroller?.removeEventListener('scroll', close);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  useEscapeLayer('menu', open, () => {
    setOpen(false);
    ref.current?.querySelector<HTMLElement>('.row-more')?.focus();
  });

  const act: MenuAction = (fn) => () => {
    fn();
    setOpen(false);
    ref.current?.querySelector<HTMLElement>('.row-more')?.focus();
  };
  const songId = catalogSongId(track);
  const goTo = (link: 'album' | 'artist') =>
    act(() => {
      if (songId && nav) openSongLink({ route: track.route, songId, link, nav });
    });

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
        <div
          ref={menuRef}
          className={`menu ${place.up ? 'is-up' : ''}`}
          role="menu"
          style={place.maxHeight ? { maxHeight: place.maxHeight, overflowY: 'auto' } : undefined}
        >
          <button role="menuitem" onClick={act(() => session.insertNext(track))}>Play next</button>
          <button role="menuitem" onClick={act(() => session.append(track))}>Add to queue</button>
          <AddToLibraryItem track={track} act={act} />
          <button role="menuitem" onClick={act(() => toggleFavorite(track))}>
            {favorite ? 'Remove from Favourite Songs' : 'Add to Favourite Songs'}
          </button>
          {songId && nav && <button role="menuitem" onClick={goTo('album')}>Go to Album</button>}
          {songId && nav && <button role="menuitem" onClick={goTo('artist')}>Go to Artist</button>}
        </div>
      )}
    </div>
  );
}

interface TrackRowProps {
  track: TrackRef;
  index: number;
  /**
   * 'album' shows number, title, duration. 'song' adds the cover, with the
   * artist under the title. 'list' adds the cover and artist and album columns.
   */
  variant: 'album' | 'song' | 'list';
  /** Hide the artist line when it repeats the album artist. */
  albumArtist?: string | undefined;
  onPlay(): void;
  /** Catalog pages pass this so the menu can offer Go to Album/Artist. */
  nav?: CatalogNav | undefined;
}

/** True for the track that is loaded now, and whether it is audibly playing. */
export function useIsCurrent(trackId: string): { isCurrent: boolean; playing: boolean } {
  const isCurrent = useUi((s) => s.snapshot.current?.track.id === trackId);
  const playing = useUi((s) => s.snapshot.status === 'playing') && isCurrent;
  return { isCurrent, playing };
}

/**
 * One track as a rounded row card; the playing track fills with the accent.
 * Clicking anywhere on the row plays it; the number cell is the play button
 * for keyboard and assistive tech.
 */
export function TrackRow({ track, index, variant, albumArtist, onPlay, nav }: TrackRowProps) {
  const { isCurrent, playing } = useIsCurrent(track.id);
  const favorite = useCollection((s) => s.favorites.some((t) => t.id === track.id));
  const artists = artistsLine(track.artists);
  const unavailable = track.availability === 'unavailable';

  return (
    <div
      className={`track-row track-row-${variant} ${isCurrent ? 'is-current' : ''} ${unavailable ? 'is-off' : ''}`}
      aria-current={isCurrent || undefined}
      title={unavailable ? track.availabilityDetail ?? 'Unavailable' : undefined}
      onClick={onPlay}
    >
      <button
        className="tr-index"
        aria-label={`Play ${track.title} by ${artists}`}
        onClick={(e) => {
          e.stopPropagation();
          onPlay();
        }}
      >
        {isCurrent ? <NowBars playing={playing} /> : <span className="tr-num">{index + 1}</span>}
        {!isCurrent && <span className="tr-play" aria-hidden="true"><PlayIcon size={15} /></span>}
      </button>
      {variant !== 'album' && (
        <span className="tr-art">
          {track.artwork ? <img src={track.artwork.url} alt="" width={42} height={42} loading="lazy" decoding="async" /> : <NoteIcon size={18} />}
        </span>
      )}
      <span className="tr-main">
        <span className="tr-title">
          <span className="tr-title-text" title={track.title}>{track.title}</span>
          {favorite && <span className="tr-fav" aria-label="Favourite"><StarIcon size={13} filled /></span>}
        </span>
        {(variant === 'song' || (variant === 'album' && artists !== albumArtist)) && <span className="tr-sub" title={artists}>{artists}</span>}
      </span>
      {variant === 'list' && <span className="tr-col tr-artist" title={artists}>{artists}</span>}
      {variant === 'list' && <span className="tr-col tr-album" title={track.album}>{track.album ?? ''}</span>}
      <span className="tr-time">{formatTime(track.durationMs)}</span>
      <TrackMenu track={track} nav={nav} />
    </div>
  );
}
