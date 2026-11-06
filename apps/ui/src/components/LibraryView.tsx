import { useCallback, useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { LibraryAlbum, TrackRef } from '@cadence/protocol';
import { api, session } from '../session';
import { formatTime } from '../format';
import { useUi } from '../hooks';
import { FolderIcon, NoteIcon, SearchIcon } from '../icons';
import { TrackRow } from './TrackRow';

export type LibraryTab = 'albums' | 'artists' | 'songs';
const TITLES: Record<LibraryTab, string> = { albums: 'Albums', artists: 'Artists', songs: 'Songs' };

function AlbumsGrid({ query, onSelectAlbum }: { query: string; onSelectAlbum(album: LibraryAlbum): void }) {
  const [albums, setAlbums] = useState<LibraryAlbum[] | null>(null);
  const scan = useUi((s) => s.scan);
  useEffect(() => {
    let live = true;
    api.library.albums(query ? { text: query } : {}).then((a) => live && setAlbums(a));
    return () => {
      live = false;
    };
    // scan.phase in deps: a finished scan or root removal refetches the grid.
  }, [query, scan.phase]);

  if (!albums) return <div className="lib-status">Loading albums…</div>;
  if (!albums.length) return <div className="lib-status">No albums match.</div>;

  return (
    <div className="album-grid">
      {albums.map((a) => (
        <button key={a.id} className="album-card" onClick={() => onSelectAlbum(a)} aria-label={`Open ${a.title} by ${a.artist}`}>
          {a.artwork ? <img src={a.artwork.url} alt="" loading="lazy" /> : <span className="album-noart"><NoteIcon size={40} /></span>}
          <span className="album-title">{a.title}</span>
          <span className="album-artist">
            {a.artist}
            {a.year ? ` · ${a.year}` : ''}
          </span>
        </button>
      ))}
    </div>
  );
}

function ArtistsList({ query }: { query: string }) {
  const [artists, setArtists] = useState<{ name: string; albumCount: number; trackCount: number }[] | null>(null);
  const scan = useUi((s) => s.scan);
  useEffect(() => {
    let live = true;
    api.library.artists({}).then((a) => live && setArtists(a));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scan.phase refetches after scans
  }, [scan.phase]);
  if (!artists) return <div className="lib-status">Loading artists…</div>;
  const shown = query ? artists.filter((a) => a.name.toLowerCase().includes(query.toLowerCase())) : artists;
  if (!shown.length) return <div className="lib-status">No artists match.</div>;

  const play = async (name: string) => {
    const tracks = await api.library.tracks({ artist: name });
    session.playTracks(tracks, 0, { kind: 'manual' });
  };

  return (
    <div className="artist-list">
      {shown.map((a) => (
        <button key={a.name} className="artist-row" onClick={() => void play(a.name)}>
          <span className="artist-avatar">{a.name.slice(0, 1).toUpperCase()}</span>
          <span className="artist-name">{a.name}</span>
          <span className="artist-counts">
            {a.albumCount} album{a.albumCount === 1 ? '' : 's'} · {a.trackCount} tracks
          </span>
        </button>
      ))}
    </div>
  );
}

function TracksTable({ query }: { query: string }) {
  const [tracks, setTracks] = useState<TrackRef[] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scan = useUi((s) => s.scan);
  useEffect(() => {
    let live = true;
    setTracks(null);
    api.library.tracks(query ? { text: query } : {}).then((t) => live && setTracks(t));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scan.phase refetches after scans
  }, [query, scan.phase]);

  const list = tracks ?? [];
  const virtualizer = useVirtualizer({
    count: list.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 56,
    overscan: 12,
  });

  if (!tracks) return <div className="lib-status">Loading tracks…</div>;
  if (!list.length) return <div className="lib-status">No tracks match.</div>;

  return (
    <div className="tr-scroll" ref={scrollRef}>
      <div className="track-head" aria-hidden="true">
        <span>#</span>
        <span />
        <span>Title</span>
        <span>Artist</span>
        <span>Album</span>
        <span>Time</span>
        <span />
      </div>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const track = list[vi.index]!;
          return (
            <div key={track.id} className="tr-row-wrap" style={{ transform: `translateY(${vi.start}px)` }}>
              <TrackRow track={track} index={vi.index} variant="list" onPlay={() => session.playTracks(list, vi.index, { kind: 'manual' })} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Library pages (Albums / Artists / Songs); the sidebar picks the tab. */
export function LibraryView({ tab, onTab, onSelectAlbum }: { tab: LibraryTab; onTab(tab: LibraryTab): void; onSelectAlbum(album: LibraryAlbum): void }) {
  const storeQuery = useUi((s) => s.libraryQuery);
  const [text, setText] = useState(storeQuery);
  const [query, setQuery] = useState(storeQuery);
  const scan = useUi((s) => s.scan);
  const [counts, setCounts] = useState<{ albums: number; tracks: number } | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([api.library.albums({}), api.library.tracks({})]).then(([a, t]) => {
      if (live) setCounts({ albums: a.length, tracks: t.length });
    }).catch(() => undefined);
    return () => { live = false; };
  }, [scan.phase]);

  // The sidebar search navigates here carrying its query — adopt it once.
  useEffect(() => {
    if (!storeQuery) return;
    setText(storeQuery);
    session.setLibraryQuery(''); // adopt once — don't resurrect it on remount
  }, [storeQuery]);

  const jumpedRef = useRef(false);
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(text.trim());
      if (!text.trim()) jumpedRef.current = false;
      else if (!jumpedRef.current) {
        jumpedRef.current = true;
        if (tab !== 'songs') onTab('songs');
      }
    }, 250);
    return () => clearTimeout(t);
  }, [text]);

  const addFolders = useCallback(() => {
    void api.library.addFoldersAndScan();
  }, []);

  const [roots, setRoots] = useState<string[] | null>(null);
  const toggleRoots = useCallback(async () => {
    if (roots !== null) {
      setRoots(null);
      return;
    }
    try {
      setRoots(await api.library.roots());
    } catch {
      setRoots([]);
    }
  }, [roots]);
  const removeRoot = useCallback((path: string) => {
    void api.library.removeRoots([path]).then(() => {
      setRoots((r) => (r === null ? r : r.filter((x) => x !== path)));
    });
  }, []);

  return (
    <div className="lib">
      <header className="lib-head">
        <h1>{TITLES[tab]}</h1>
        {counts && <span className="lib-count">{counts.albums} albums · {counts.tracks} songs</span>}
      </header>
      <div className="lib-bar">
        <div className="lib-search">
          <SearchIcon size={16} />
          <input
            type="search"
            placeholder="Search title, artist, album"
            aria-label="Search library"
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
          />
        </div>
        <button className="btn btn-ghost" onClick={addFolders}>
          <FolderIcon size={16} /> Add folders
        </button>
        <button className="btn btn-ghost" onClick={() => void toggleRoots()} aria-expanded={roots !== null}>
          Folders
        </button>
      </div>
      {roots !== null && (
        <div className="lib-roots" role="list" aria-label="Library folders">
          {roots.length === 0 && <span className="lib-roots-empty">No folders indexed.</span>}
          {roots.map((r) => (
            <div key={r} className="lib-root" role="listitem">
              <span className="lib-root-path" title={r}>{r}</span>
              <button className="btn btn-ghost lib-root-x" aria-label={`Remove ${r}`} onClick={() => removeRoot(r)}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {scan.phase === 'scanning' && (
        <div className="scan" role="status">
          <div className="scan-fill" style={{ width: `${scan.total ? Math.min(100, (scan.scanned / scan.total) * 100) : 5}%` }} />
          <span className="scan-label">
            Scanning {scan.scanned}
            {scan.total ? `/${scan.total}` : ''}…
          </span>
        </div>
      )}
      <div className="lib-body">
        {tab === 'albums' && <AlbumsGrid query={query} onSelectAlbum={onSelectAlbum} />}
        {tab === 'artists' && <ArtistsList query={query} />}
        {tab === 'songs' && <TracksTable query={query} />}
      </div>
    </div>
  );
}
