import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { LibraryAlbum, TrackRef } from '@cadence/protocol';
import { api, session } from '../session';
import { albumKey, useCollection } from '../collection';
import { useUi } from '../hooks';
import { ChevronIcon, NoteIcon, PlayIcon, RefreshIcon } from '../icons';
import './home.css';

interface HomeViewProps {
  onSelectAlbum(album: LibraryAlbum): void;
}

async function playAlbum(album: LibraryAlbum) {
  const tracks = await api.library.tracks({ album: album.title, artist: album.artist });
  session.playTracks(tracks, 0, { kind: 'album', id: album.id, name: album.title });
}

/** Horizontal rail with previous/next buttons that step by visible width. */
function Shelf({ head, label, children }: { head: ReactNode; label: string; children: ReactNode }) {
  const railRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const update = useCallback(() => {
    const el = railRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ start: el.scrollLeft <= 2, end: el.scrollLeft >= max - 2 });
  }, []);
  useEffect(() => {
    update();
    const observer = new ResizeObserver(update);
    if (railRef.current) observer.observe(railRef.current);
    return () => observer.disconnect();
  }, [update, children]);
  const step = (direction: -1 | 1) => {
    const el = railRef.current;
    if (!el) return;
    const card = el.firstElementChild as HTMLElement | null;
    const width = card ? card.offsetWidth + 16 : 240;
    const visible = Math.max(1, Math.floor(el.clientWidth / width) - 1);
    el.scrollBy({ left: direction * visible * width, behavior: 'smooth' });
  };
  const scrolls = !(edges.start && edges.end);
  return (
    <section className="shelf" aria-label={label}>
      <div className="shelf-head">
        {head}
        {scrolls && (
          <div className="shelf-arrows">
            <button className="round-btn" aria-label={`Scroll ${label} back`} disabled={edges.start} onClick={() => step(-1)}>
              <ChevronIcon dir="left" size={18} />
            </button>
            <button className="round-btn" aria-label={`Scroll ${label} forward`} disabled={edges.end} onClick={() => step(1)}>
              <ChevronIcon dir="right" size={18} />
            </button>
          </div>
        )}
      </div>
      <div className="shelf-rail" ref={railRef} onScroll={update}>
        {children}
      </div>
    </section>
  );
}

function Cover({ album, eager }: { album: LibraryAlbum; eager?: boolean }) {
  return album.artwork
    ? <img src={album.artwork.url} alt="" loading={eager ? 'eager' : 'lazy'} draggable={false} />
    : <span className="cover-empty"><NoteIcon size={40} /></span>;
}

/** Tall poster card with the caption laid over a dark fade. */
function PosterCard({ album, label, index, onOpen }: { album: LibraryAlbum; label: string | undefined; index: number; onOpen(): void }) {
  return (
    <div className="poster-card" style={{ '--i': index } as CSSProperties}>
      <button className="poster-open" onClick={onOpen} aria-label={`Open ${album.title} by ${album.artist}`}>
        <span className="poster-art"><Cover album={album} eager /></span>
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

/** Square card with title and artist below the artwork. */
function SquareCard({ album, index, onOpen }: { album: LibraryAlbum; index: number; onOpen(): void }) {
  return (
    <div className="square-card" style={{ '--i': index } as CSSProperties}>
      <button className="square-open" onClick={onOpen} aria-label={`Open ${album.title} by ${album.artist}`}>
        <span className="square-art"><Cover album={album} /></span>
        <span className="square-title">{album.title}</span>
        <span className="square-artist">{album.artist}</span>
      </button>
      <button className="card-play" aria-label={`Play ${album.title}`} onClick={() => void playAlbum(album)}>
        <PlayIcon size={18} />
      </button>
    </div>
  );
}

function SkeletonShelf({ tall }: { tall?: boolean }) {
  return (
    <section className="shelf" aria-hidden="true">
      <div className="shelf-head"><span className="skeleton skeleton-title" /></div>
      <div className="shelf-rail">
        {Array.from({ length: 6 }, (_, i) => <span key={i} className={`skeleton ${tall ? 'skeleton-poster' : 'skeleton-square'}`} />)}
      </div>
    </section>
  );
}

export function HomeView({ onSelectAlbum }: HomeViewProps) {
  const [albums, setAlbums] = useState<LibraryAlbum[] | null>(null);
  const [tracks, setTracks] = useState<TrackRef[]>([]);
  const [nonce, setNonce] = useState(0);
  const scan = useUi((s) => s.scan);
  const recent = useCollection((s) => s.recent);

  useEffect(() => {
    let live = true;
    setAlbums(null);
    void Promise.all([api.library.albums({}), api.library.tracks({}).catch(() => [] as TrackRef[])])
      .then(([a, t]) => {
        if (!live) return;
        setAlbums(a);
        setTracks(t);
      })
      .catch(() => live && setAlbums([]));
    return () => {
      live = false;
    };
  }, [scan.phase, nonce]);

  // Genres per album, derived from track tags.
  const genres = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const t of tracks) {
      const artist = t.artists[0]?.name;
      if (!t.album || !artist || !t.genre?.length) continue;
      const key = albumKey(t.album, artist);
      if (!map.has(key)) map.set(key, t.genre);
    }
    return map;
  }, [tracks]);

  const byKey = useMemo(() => new Map((albums ?? []).map((a) => [albumKey(a.title, a.artist), a])), [albums]);
  const played = useMemo(() => recent.map((k) => byKey.get(k)).filter((a): a is LibraryAlbum => !!a), [recent, byKey]);

  // "More like" seeds from the latest played album and matches shared genres.
  const seed = played[0] ?? albums?.[0];
  const similar = useMemo(() => {
    if (!seed || !albums) return [];
    const seedGenres = genres.get(albumKey(seed.title, seed.artist)) ?? [];
    return albums.filter((a) => a.id !== seed.id && (genres.get(albumKey(a.title, a.artist)) ?? []).some((g) => seedGenres.includes(g)));
  }, [seed, albums, genres]);

  const posterLabel = (album: LibraryAlbum) => {
    const genre = genres.get(albumKey(album.title, album.artist))?.[0];
    return [genre, album.year].filter(Boolean).join(' · ') || undefined;
  };

  return (
    <div className="stage-scroll home">
      <header className="page-head">
        <h1>Home</h1>
        <button className="round-btn round-btn-lg" aria-label="Refresh" title="Refresh" onClick={() => setNonce((n) => n + 1)}>
          <RefreshIcon size={20} />
        </button>
      </header>
      {albums === null ? (
        <>
          <SkeletonShelf tall />
          <SkeletonShelf />
        </>
      ) : albums.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon"><NoteIcon size={30} /></span>
          <h2>Bring your music to Cadence</h2>
          <p>Add a music folder from Library to fill your shelves.</p>
        </div>
      ) : (
        <>
          <Shelf label="Your albums" head={<h2>Your albums</h2>}>
            {albums.map((album, i) => (
              <PosterCard key={album.id} album={album} index={i} label={posterLabel(album)} onOpen={() => onSelectAlbum(album)} />
            ))}
          </Shelf>
          {played.length > 0 && (
            <Shelf label="Recently played" head={<h2>Recently played</h2>}>
              {played.map((album, i) => <SquareCard key={album.id} album={album} index={i} onOpen={() => onSelectAlbum(album)} />)}
            </Shelf>
          )}
          {seed && similar.length > 0 && (
            <Shelf
              label={`More like ${seed.title}`}
              head={
                <button className="shelf-seed" onClick={() => onSelectAlbum(seed)}>
                  <span className="shelf-seed-art"><Cover album={seed} /></span>
                  <span className="shelf-seed-copy">
                    <span className="shelf-seed-label">More like</span>
                    <span className="shelf-seed-title">{seed.title} <ChevronIcon dir="right" size={18} /></span>
                  </span>
                </button>
              }
            >
              {similar.map((album, i) => <SquareCard key={album.id} album={album} index={i} onOpen={() => onSelectAlbum(album)} />)}
            </Shelf>
          )}
        </>
      )}
    </div>
  );
}
