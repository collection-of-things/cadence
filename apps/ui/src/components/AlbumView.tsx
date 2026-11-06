import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { LibraryAlbum, TrackRef } from '@cadence/protocol';
import { api, session } from '../session';
import { togglePin, useCollection } from '../collection';
import { useUi } from '../hooks';
import { CheckIcon, ClockIcon, NoteIcon, PinIcon, PlayIcon, PlusIcon, SearchIcon, ShuffleIcon, SongIcon, SortIcon } from '../icons';
import { DEFAULT_PALETTE, extractPalette, type Rgb } from '../palette';
import { TrackRow } from './TrackRow';
import './home.css';

function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

type Sort = 'track' | 'title' | 'duration';
const SORT_LABEL: Record<Sort, string> = { track: 'Track order', title: 'Title', duration: 'Duration' };
const NEXT_SORT: Record<Sort, Sort> = { track: 'title', title: 'duration', duration: 'track' };

/** Album detail: artwork-washed hero, facts, actions and a filterable track list. */
export function AlbumView({ album }: { album: LibraryAlbum }) {
  const [tracks, setTracks] = useState<TrackRef[] | null>(null);
  const [palette, setPalette] = useState<Rgb[]>(DEFAULT_PALETTE);
  const [filter, setFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>('track');
  const filterRef = useRef<HTMLInputElement>(null);
  const scan = useUi((s) => s.scan);
  const filtering = filter !== null;
  const pinned = useCollection((s) => s.pins.some((p) => p.id === album.id));

  useEffect(() => {
    let live = true;
    setTracks(null);
    void api.library.tracks({ album: album.title, artist: album.artist })
      .then((result) => live && setTracks(result))
      .catch(() => live && setTracks([]));
    return () => {
      live = false;
    };
  }, [album.title, album.artist, scan.phase]);

  useEffect(() => {
    let live = true;
    if (!album.artwork?.url) return;
    void extractPalette(album.artwork.url).then((result) => live && setPalette(result ?? DEFAULT_PALETTE));
    return () => {
      live = false;
    };
  }, [album.artwork?.url]);

  useEffect(() => {
    if (filtering) filterRef.current?.focus();
  }, [filtering]);

  const shown = useMemo(() => {
    if (!tracks) return [];
    const q = filter?.trim().toLowerCase();
    const list = q ? tracks.filter((t) => t.title.toLowerCase().includes(q)) : [...tracks];
    if (sort === 'title') list.sort((a, b) => a.title.localeCompare(b.title));
    if (sort === 'duration') list.sort((a, b) => a.durationMs - b.durationMs);
    return list;
  }, [tracks, filter, sort]);

  const genre = tracks?.[0]?.genre?.[0];
  const year = album.year ?? tracks?.[0]?.year;
  const count = tracks?.length ?? album.trackCount;
  const [c0, c1] = [palette[0] ?? DEFAULT_PALETTE[0]!, palette[1] ?? palette[0] ?? DEFAULT_PALETTE[0]!];
  const style = { '--wash-a': c0.join(' '), '--wash-b': c1.join(' ') } as CSSProperties;
  const origin = { kind: 'album' as const, id: album.id, name: album.title };
  const ready = !!tracks?.length;

  return (
    <div className="album" style={style}>
      <div className="album-wash" aria-hidden="true" />
      <div className="stage-scroll album-scroll">
        <div className="album-corner">
          <button
            className={`round-btn ${pinned ? 'is-on' : ''}`}
            aria-label={pinned ? 'Unpin album' : 'Pin album to sidebar'}
            aria-pressed={pinned}
            title={pinned ? 'Unpin' : 'Pin to sidebar'}
            onClick={() => togglePin(album)}
          >
            <PinIcon size={18} filled={pinned} />
          </button>
        </div>
        <section className="album-hero">
          <div className="album-art">
            {album.artwork ? <img src={album.artwork.url} alt={`${album.title} artwork`} draggable={false} /> : <NoteIcon size={64} />}
          </div>
          <div className="album-info">
            <h1>{album.title}</h1>
            <div className="album-byline">
              <span className="album-avatar" aria-hidden="true">
                {album.artwork ? <img src={album.artwork.url} alt="" /> : album.artist.slice(0, 1)}
              </span>
              <span>{album.artist}</span>
              {pinned && <span className="album-pinned" title="Pinned"><CheckIcon size={16} /></span>}
            </div>
            <div className="album-chips">
              {genre && <span className="chip"><NoteIcon size={13} />{genre}</span>}
              {year && <span className="chip"><ClockIcon size={13} />{year}</span>}
              <span className="chip"><SongIcon size={13} />{count} {count === 1 ? 'track' : 'tracks'}</span>
            </div>
            <div className="album-actions">
              <button className="round-btn round-btn-lg" aria-label="Shuffle album" title="Shuffle" disabled={!ready} onClick={() => tracks && session.playTracks(shuffled(tracks), 0, origin)}>
                <ShuffleIcon size={19} />
              </button>
              <button className="play-pill" disabled={!ready} onClick={() => tracks && session.playTracks(tracks, 0, origin)}>
                <PlayIcon size={18} /> Play
              </button>
              <button className="round-btn round-btn-lg" aria-label="Add album to queue" title="Add to queue" disabled={!ready} onClick={() => tracks?.forEach((t) => session.append(t))}>
                <PlusIcon size={20} />
              </button>
            </div>
          </div>
        </section>

        <section className="album-tracks" aria-label={`${album.title} tracks`}>
          <div className="list-toolbar">
            {filter === null ? (
              <button className="ghost-btn" aria-label="Filter tracks" title="Filter tracks" onClick={() => setFilter('')}>
                <SearchIcon size={17} />
              </button>
            ) : (
              <label className="list-filter">
                <SearchIcon size={16} />
                <input
                  ref={filterRef}
                  aria-label="Filter tracks"
                  placeholder="Filter tracks"
                  value={filter}
                  onChange={(e) => setFilter(e.currentTarget.value)}
                  onBlur={(e) => !e.currentTarget.value && setFilter(null)}
                  onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setFilter(null))}
                />
              </label>
            )}
            <button className="ghost-btn" aria-label={`Sort: ${SORT_LABEL[sort]}`} title={`Sort: ${SORT_LABEL[sort]}`} onClick={() => setSort(NEXT_SORT[sort])}>
              <SortIcon size={17} />
              {sort !== 'track' && <span className="ghost-btn-text">{SORT_LABEL[sort]}</span>}
            </button>
          </div>
          {tracks === null ? (
            <div className="track-list" aria-hidden="true">
              {Array.from({ length: 7 }, (_, i) => <span key={i} className="skeleton skeleton-row" />)}
            </div>
          ) : shown.length === 0 ? (
            <p className="list-empty">{tracks.length ? 'No tracks match.' : 'No tracks found for this album.'}</p>
          ) : (
            <div className="track-list">
              {shown.map((track) => (
                <TrackRow
                  key={track.id}
                  track={track}
                  index={(track.trackNumber ?? tracks.indexOf(track) + 1) - 1}
                  variant="album"
                  albumArtist={album.artist}
                  onPlay={() => session.playTracks(shown, shown.indexOf(track), origin)}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
