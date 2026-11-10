import type { LibraryAlbum } from '@cadence/protocol';
import { api, session } from '../session';
import { togglePin, useCollection } from '../collection';
import { CheckIcon, ClockIcon, NoteIcon, PinIcon, PlayIcon, ShuffleIcon, SongIcon } from '../icons';
import { useLibraryRead } from '../library';
import { useCoverTheme } from '../pageTint';
import { AddGlyph, useJustAdded } from './AddGlyph';
import { TrackListToolbar, useTrackListControls } from './TrackListToolbar';
import { TrackRow } from './TrackRow';
import './home.css';

/** Album detail: artwork-washed hero, facts, actions and a filterable track list. */
export function AlbumView({ album }: { album: LibraryAlbum }) {
  const tracks = useLibraryRead(() => api.library.tracks({ album: album.title, artist: album.artist }), [album.title, album.artist], []);
  const { shown, controls } = useTrackListControls(tracks);
  const pinned = useCollection((s) => s.pins.some((p) => p.id === album.id));

  const genre = tracks?.[0]?.genre?.[0];
  const year = album.year ?? tracks?.[0]?.year;
  const count = tracks?.length ?? album.trackCount;
  // The page wears this cover's colours: the flood, Play and the playing row.
  const style = useCoverTheme(album.artwork?.url);
  const origin = { kind: 'album' as const, id: album.id, name: album.title };
  const ready = !!tracks?.length;
  const queued = useJustAdded();

  return (
    <div className="album" style={style}>
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
              <button className="round-btn album-round" aria-label="Shuffle album" title="Shuffle" disabled={!ready} onClick={() => tracks && session.playShuffled(tracks, origin)}>
                <ShuffleIcon size={18} />
              </button>
              <button className="play-pill album-play-pill" disabled={!ready} onClick={() => tracks && session.playTracks(tracks, 0, origin)}>
                <PlayIcon size={17} /> Play
              </button>
              <button
                className="round-btn album-round"
                aria-label="Add album to queue"
                title={queued.added ? 'Added to queue' : 'Add to queue'}
                disabled={!ready}
                onClick={() => {
                  if (tracks) session.append(tracks);
                  queued.flash();
                }}
              >
                <AddGlyph added={queued.added} size={18} />
              </button>
            </div>
          </div>
        </section>

        <section className="album-tracks" aria-label={`${album.title} tracks`}>
          <TrackListToolbar {...controls} />
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
