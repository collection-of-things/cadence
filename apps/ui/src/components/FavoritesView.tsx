import { session } from '../session';
import { useCollection } from '../collection';
import { PlayIcon, ShuffleIcon, SongIcon, StarIcon } from '../icons';
import { TrackRow } from './TrackRow';
import { pageTheme } from '../theme';
import { usePublishPageTint } from '../pageTint';
import './home.css';

const origin = { kind: 'playlist' as const, id: 'favorites', name: 'Favourite Songs' };
/** Favourite Songs has no cover: it wears a fixed rose. */
const FAVORITES_THEME = pageTheme([[250, 45, 72], [140, 30, 60]]);

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
            <div className="album-chips">
              <span className="chip"><SongIcon size={13} />{favorites.length} {favorites.length === 1 ? 'track' : 'tracks'}</span>
            </div>
            <div className="album-actions">
              <button className="round-btn album-round" aria-label="Shuffle favourites" title="Shuffle" disabled={!ready}
                onClick={() => session.playShuffled(favorites, origin)}>
                <ShuffleIcon size={18} />
              </button>
              <button className="play-pill album-play-pill" disabled={!ready} onClick={() => session.playTracks(favorites, 0, origin)}>
                <PlayIcon size={17} /> Play
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
