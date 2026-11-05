import { useCallback, useEffect, useRef, useState } from 'react';
import type { LibraryAlbum } from '@cadence/protocol';
import { api } from '../app';
import { useUi } from '../hooks';
import { NoteIcon } from '../icons';
import './home.css';

interface HomeViewProps {
  onSelectAlbum(album: LibraryAlbum): void;
}

function Shelf({ title, subtitle, albums, onSelectAlbum }: {
  title: string;
  subtitle?: string;
  albums: LibraryAlbum[];
  onSelectAlbum(album: LibraryAlbum): void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<{ left: boolean; right: boolean }>({ left: true, right: true });
  const updateEdges = useCallback(() => {
    const el = railRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ left: el.scrollLeft <= 2 || max <= 4, right: el.scrollLeft >= max - 2 || max <= 4 });
  }, []);
  useEffect(() => {
    updateEdges();
    window.addEventListener('resize', updateEdges);
    return () => window.removeEventListener('resize', updateEdges);
  }, [updateEdges, albums]);
  const scroll = (direction: -1 | 1) => {
    const el = railRef.current;
    if (!el) return;
    const card = el.querySelector('.home-album-card') as HTMLElement | null;
    const step = card ? card.offsetWidth + 14 : 540;
    el.scrollBy({ left: direction * step * 2, behavior: 'smooth' });
  };

  if (!albums.length) return null;
  return (
    <section className="home-shelf" aria-label={title}>
      <div className="home-shelf-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <div className="shelf-controls">
          <button className="shelf-arrow" aria-label={`Scroll ${title} left`} disabled={edges.left} onClick={() => scroll(-1)}>
            <Arrow direction="back" />
          </button>
          <button className="shelf-arrow" aria-label={`Scroll ${title} right`} disabled={edges.right} onClick={() => scroll(1)}>
            <Arrow direction="forward" />
          </button>
        </div>
      </div>
      <div className="home-rail" ref={railRef} onScroll={updateEdges}>
        {albums.map((album, index) => (
          <button
            className="home-album-card"
            key={album.id}
            onClick={() => onSelectAlbum(album)}
            aria-label={`Open ${album.title} by ${album.artist}`}
          >
            <span className="home-cover">
              {album.artwork ? <img src={album.artwork.url} alt="" loading={index > 3 ? 'lazy' : 'eager'} /> : <span className="home-cover-empty"><NoteIcon size={36} /></span>}
              <span className="home-cover-shade" />
              <span className="home-cover-meta">
                <span className="home-cover-title">{album.title}</span>
                <span className="home-cover-artist">{album.artist}</span>
              </span>
              <span className="home-card-open" aria-hidden="true"><Arrow direction="forward" /></span>
            </span>

          </button>
        ))}
      </div>
    </section>
  );
}

function Arrow({ direction }: { direction: 'back' | 'forward' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d={direction === 'back' ? 'm14.8 5.5-6.5 6.5 6.5 6.5' : 'm9.2 5.5 6.5 6.5-6.5 6.5'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function HomeView({ onSelectAlbum }: HomeViewProps) {
  const [albums, setAlbums] = useState<LibraryAlbum[] | null>(null);
  const [genreShelf, setGenreShelf] = useState<{ name: string; albums: LibraryAlbum[] } | null>(null);
  const scan = useUi((s) => s.scan);
  useEffect(() => {
    let live = true;
    setAlbums(null);
    void api.library.albums({}).then((result) => {
      if (!live) return;
      setAlbums(result);
      // Build a real genre shelf: dominant genre across tracks, albums
      // whose titles appear in it. No fake curation.
      void api.library.tracks({}).then((tracks) => {
        if (!live) return;
        const byGenre = new Map<string, Set<string>>();
        for (const t of tracks) {
          for (const g of t.genre ?? []) {
            const set = byGenre.get(g) ?? new Set<string>();
            if (t.album) set.add(t.album);
            byGenre.set(g, set);
          }
        }
        const best = [...byGenre.entries()].sort((a, b) => b[1].size - a[1].size)[0];
        if (!best) return;
        const matching = result.filter((a) => best[1].has(a.title));
        if (matching.length >= 2) setGenreShelf({ name: best[0], albums: matching });
      }).catch(() => undefined);
    }).catch(() => {
      if (live) setAlbums([]);
    });
    return () => {
      live = false;
    };
  }, [scan.phase]);

  return (
    <div className="home-view">
      <div className="home-scroll">
        <header className="home-intro">
          <h1>Home</h1>
        </header>
        {albums === null ? (
          <div className="home-loading" role="status">Gathering your albums…</div>
        ) : albums.length === 0 ? (
          <div className="home-empty">
            <span className="home-empty-icon"><NoteIcon size={28} /></span>
            <div><h2>Your shelves are waiting</h2><p>Add a music folder from Library to see your albums here.</p></div>
          </div>
        ) : (
          <>
            <Shelf title="Your albums" subtitle={`${albums.length} ${albums.length === 1 ? 'album' : 'albums'} in your library`} albums={albums} onSelectAlbum={onSelectAlbum} />
            {genreShelf && (
              <Shelf title={genreShelf.name} subtitle={`${genreShelf.albums.length} albums in this corner of your library`} albums={genreShelf.albums} onSelectAlbum={onSelectAlbum} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
