import type { CSSProperties } from 'react';
import { session } from '../session';
import { useCollection } from '../collection';
import { PlayIcon, ShuffleIcon, SongIcon, StarIcon } from '../icons';
import { TrackRow } from './TrackRow';
import './home.css';

const origin = { kind: 'playlist' as const, id: 'favorites', name: 'Favourite Songs' };

/** Favourite Songs playlist, backed by the renderer collection store. */
export function FavoritesView() {
  const favorites = useCollection((s) => s.favorites);
  const style = { '--wash-a': '250 45 72', '--wash-b': '140 30 60' } as CSSProperties;
  const ready = favorites.length > 0;

  return (
    <div className="album" style={style}>
      <div className="album-wash" aria-hidden="true" />
      <div className="stage-scroll album-scroll">
        <section className="album-hero">
          <div className="album-art playlist-art"><StarIcon size={96} filled /></div>
          <div className="album-info">
            <h1>Favourite Songs</h1>
            <div className="album-chips">
              <span className="chip"><SongIcon size={13} />{favorites.length} {favorites.length === 1 ? 'track' : 'tracks'}</span>
            </div>
            <div className="album-actions">
              <button className="round-btn round-btn-lg" aria-label="Shuffle favourites" disabled={!ready}
                onClick={() => session.playTracks([...favorites].sort(() => Math.random() - 0.5), 0, origin)}>
                <ShuffleIcon size={19} />
              </button>
              <button className="play-pill" disabled={!ready} onClick={() => session.playTracks(favorites, 0, origin)}>
                <PlayIcon size={18} /> Play
              </button>
            </div>
          </div>
        </section>
        <section className="album-tracks" aria-label="Favourite songs">
          {ready ? (
            <div className="track-list">
              {favorites.map((track, i) => (
                <TrackRow key={track.id} track={track} index={i} variant="list" onPlay={() => session.playTracks(favorites, i, origin)} />
              ))}
            </div>
          ) : (
            <p className="list-empty">Star a song from the player or a track’s ⋯ menu to keep it here.</p>
          )}
        </section>
      </div>
    </div>
  );
}
