import { useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { TrackRef } from '@cadence/protocol';
import { session } from '../session';
import { useCollection } from '../collection';
import { PlayIcon, ShuffleIcon, SongIcon, StarIcon } from '../icons';
import { TrackRow } from './TrackRow';
import { pageTheme } from '../theme';
import { usePublishPageTint } from '../pageTint';
import { EmptyState } from './Shelf';
import './home.css';

const origin = { kind: 'playlist' as const, id: 'favorites', name: 'Favourite Songs' };
/** Favourite Songs has no cover: it wears a fixed rose. */
const FAVORITES_THEME = pageTheme([[250, 45, 72], [140, 30, 60]]);

const ROW_HEIGHT = 60; // 58px row + 2px gap

/** Rows virtualised against the page's own scroller, which also holds the hero above. */
function VirtualFavorites({ tracks }: { tracks: TrackRef[] }) {
  const listRef = useRef<HTMLDivElement>(null);
  const scrollEl = useRef<HTMLElement | null>(null);
  const [margin, setMargin] = useState(0);

  useLayoutEffect(() => {
    const list = listRef.current;
    const scroller = list?.closest<HTMLElement>('.stage-scroll') ?? null;
    scrollEl.current = scroller;
    if (!list || !scroller) return;
    const measure = () =>
      setMargin(list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  const virtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => scrollEl.current,
    estimateSize: () => ROW_HEIGHT,
    scrollMargin: margin,
    overscan: 10,
  });

  return (
    <div className="track-list" ref={listRef} style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
      {virtualizer.getVirtualItems().map((vi) => {
        const track = tracks[vi.index]!;
        return (
          <div
            key={track.id}
            className={`fav-row ${vi.index % 2 === 1 ? 'is-even' : ''}`}
            style={{ transform: `translateY(${vi.start - margin}px)` }}
          >
            <TrackRow track={track} index={vi.index} variant="list" onPlay={() => session.playTracks(tracks, vi.index, origin)} />
          </div>
        );
      })}
    </div>
  );
}

/** Favourite Songs playlist, backed by the renderer collection store. */
export function FavoritesView() {
  const favorites = useCollection((s) => s.favorites);
  const ready = favorites.length > 0;
  usePublishPageTint(FAVORITES_THEME);

  return (
    <div className="album" style={FAVORITES_THEME}>
      <div className="stage-scroll album-scroll">
        <section className="album-hero">
          <div className="album-art playlist-art"><StarIcon size={96} filled /></div>
          <div className="album-info">
            <h1>Favourite Songs</h1>
            {/* Empty, the page explains itself below instead of offering dead controls. */}
            {ready ? (
              <>
                <div className="album-chips">
                  <span className="chip"><SongIcon size={13} />{favorites.length} {favorites.length === 1 ? 'track' : 'tracks'}</span>
                </div>
                <div className="album-actions">
                  <button className="round-btn album-round" aria-label="Shuffle favourites" title="Shuffle"
                    onClick={() => session.playShuffled(favorites, origin)}>
                    <ShuffleIcon size={18} />
                  </button>
                  <button className="play-pill album-play-pill" onClick={() => session.playTracks(favorites, 0, origin)}>
                    <PlayIcon size={17} /> Play
                  </button>
                </div>
              </>
            ) : (
              <p className="album-lede">Your starred songs, in one place.</p>
            )}
          </div>
        </section>
        <section className="album-tracks" aria-label="Favourite songs">
          {ready ? (
            <VirtualFavorites tracks={favorites} />
          ) : (
            <EmptyState title="No favourites yet" body="Star a song in the player or from a track’s ⋯ menu and it will appear here." icon={<StarIcon size={28} />} />
          )}
        </section>
      </div>
    </div>
  );
}
