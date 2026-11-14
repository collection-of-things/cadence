import { useMemo, useState } from 'react';
import type { LibraryAlbum } from '@cadence/protocol';
import { api } from '../session';
import { albumKey, useCollection } from '../collection';
import { ChevronIcon, PlayIcon, RefreshIcon } from '../icons';
import { playAlbum, useLibraryRead } from '../library';
import { Cover, EmptyState, Shelf, ShelfTitle, SkeletonShelf, SquareCard } from './Shelf';
import './home.css';

interface HomeViewProps {
  onSelectAlbum(album: LibraryAlbum): void;
}

/** Tall poster card with the caption laid over a dark fade. */
function PosterCard({ album, label, onOpen }: { album: LibraryAlbum; label: string | undefined; onOpen(): void }) {
  return (
    <div className="poster-card">
      <button className="poster-open" onClick={onOpen} aria-label={`Open ${album.title} by ${album.artist}`}>
        <span className="poster-art"><Cover art={album.artwork} eager /></span>
        <span className="poster-caption">
          {label && <span className="poster-label">{label}</span>}
          <span className="poster-title">{album.title}</span>
          <span className="poster-artist">{album.artist}</span>
        </span>
      </button>
      <button className="card-play" aria-label={`Play ${album.title}`} onClick={() => void playAlbum(album)}>
        <PlayIcon size={18} />
      </button>
    </div>
  );
}

/** A local album as a square card: open it, or play it from the cover. */
function AlbumCard({ album, onOpen }: { album: LibraryAlbum; onOpen(): void }) {
  return (
    <SquareCard
      title={album.title}
      sub={album.artist}
      art={album.artwork}
      label={`Open ${album.title} by ${album.artist}`}
      onOpen={onOpen}
      onPlay={() => void playAlbum(album)}
    />
  );
}

export function HomeView({ onSelectAlbum }: HomeViewProps) {
  // Refresh bumps this to read the library again.
  const [refreshes, setRefreshes] = useState(0);
  const albums = useLibraryRead(() => api.library.albums({}), [refreshes], []);
  const recent = useCollection((s) => s.recent);

  const byKey = useMemo(() => new Map((albums ?? []).map((a) => [albumKey(a.title, a.artist), a])), [albums]);
  const played = useMemo(() => recent.map((k) => byKey.get(k)).filter((a): a is LibraryAlbum => !!a), [recent, byKey]);

  // "More like" seeds from the latest played album and matches shared genres.
  const seed = played[0] ?? albums?.[0];
  const similar = useMemo(() => {
    const seedGenres = seed?.genre ?? [];
    if (!seed || !albums) return [];
    return albums.filter((a) => a.id !== seed.id && (a.genre ?? []).some((g) => seedGenres.includes(g)));
  }, [seed, albums]);

  const posterLabel = (album: LibraryAlbum) => {
    return [album.genre?.[0], album.year].filter(Boolean).join(' · ') || undefined;
  };

  return (
    <div className="stage-scroll home">
      <header className="page-head">
        <h1>Home</h1>
        <button className="round-btn round-btn-lg" aria-label="Refresh" title="Refresh" onClick={() => setRefreshes((n) => n + 1)}>
          <RefreshIcon size={20} />
        </button>
      </header>
      {albums === null ? (
        <>
          <SkeletonShelf tall />
          <SkeletonShelf />
        </>
      ) : albums.length === 0 ? (
        <EmptyState title="Bring your music to Cadence" body="Add a music folder from Library to fill your shelves." />
      ) : (
        <>
          <Shelf label="Your albums" head={<ShelfTitle title="Your albums" />}>
            {albums.map((album) => (
              <PosterCard key={album.id} album={album} label={posterLabel(album)} onOpen={() => onSelectAlbum(album)} />
            ))}
          </Shelf>
          {played.length > 0 && (
            <Shelf label="Recently played" head={<ShelfTitle title="Recently played" />}>
              {played.map((album) => <AlbumCard key={album.id} album={album} onOpen={() => onSelectAlbum(album)} />)}
            </Shelf>
          )}
          {seed && similar.length > 0 && (
            <Shelf
              label={`More like ${seed.title}`}
              head={
                <button className="shelf-seed" onClick={() => onSelectAlbum(seed)}>
                  <span className="shelf-seed-art"><Cover art={seed.artwork} /></span>
                  <span className="shelf-seed-copy">
                    <span className="shelf-seed-label">More like</span>
                    <span className="shelf-seed-title">{seed.title} <ChevronIcon dir="right" size={18} /></span>
                  </span>
                </button>
              }
            >
              {similar.map((album) => <AlbumCard key={album.id} album={album} onOpen={() => onSelectAlbum(album)} />)}
            </Shelf>
          )}
        </>
      )}
    </div>
  );
}
