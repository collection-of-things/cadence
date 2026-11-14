import type { LibraryAlbum } from '@cadence/protocol';
import { api, session } from '../session';
import { PlayIcon, ShuffleIcon } from '../icons';
import { playAlbum, useLibraryRead } from '../library';
import { EmptyState, Shelf, ShelfTitle, SkeletonRows, SkeletonShelf, SquareCard } from './Shelf';
import { TrackRow } from './TrackRow';
import './home.css';

/** An artist in the local library: play or shuffle everything, their albums, then their songs. */
export function LocalArtistView({ name, onSelectAlbum }: { name: string; onSelectAlbum(album: LibraryAlbum): void }) {
  const albums = useLibraryRead(() => api.library.albums({ artist: name }), [name], []);
  const tracks = useLibraryRead(() => api.library.tracks({ artist: name }), [name], []);
  const origin = { kind: 'manual' as const, name };
  const ready = !!tracks?.length;

  return (
    <div className="stage-scroll home artist-page">
      <header className="page-head"><h1>{name}</h1></header>
      <div className="album-actions artist-actions">
        <button className="round-btn album-round" aria-label={`Shuffle ${name}`} title="Shuffle" disabled={!ready} onClick={() => tracks && session.playShuffled(tracks, origin)}>
          <ShuffleIcon size={18} />
        </button>
        <button className="play-pill album-play-pill" disabled={!ready} onClick={() => tracks && session.playTracks(tracks, 0, origin)}>
          <PlayIcon size={17} /> Play
        </button>
      </div>

      {albums === null && <SkeletonShelf />}
      {albums !== null && albums.length > 0 && (
        <Shelf label="Albums" head={<ShelfTitle title="Albums" />}>
          {albums.map((album) => (
            <SquareCard
              key={album.id}
              title={album.title}
              sub={album.year ? String(album.year) : undefined}
              art={album.artwork}
              label={`Open ${album.title}`}
              onOpen={() => onSelectAlbum(album)}
              onPlay={() => void playAlbum(album)}
            />
          ))}
        </Shelf>
      )}

      <section className="shelf" aria-label="Songs">
        <div className="shelf-head"><ShelfTitle title="Songs" /></div>
        {tracks === null && <SkeletonRows />}
        {tracks !== null && tracks.length === 0 && <EmptyState title="No songs found" body="This artist has no tracks in your library." />}
        {tracks !== null && tracks.length > 0 && (
          <div className="track-list">
            {tracks.map((track, i) => (
              <TrackRow key={track.id} track={track} index={i} variant="list" onPlay={() => session.playTracks(tracks, i, origin)} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
