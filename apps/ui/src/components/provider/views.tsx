/**
 * Provider pages — thin wrappers over the shared catalog machinery.
 * Apple Music gets the full treatment today; other platforms slot in behind
 * the same CatalogPage surface.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CatalogArtist,
  CatalogContainer,
  CatalogEntry,
  CatalogRequest,
  TrackRef,
} from '@cadence/protocol';
import { stationToTrack } from '@cadence/protocol';
import { api, session } from '../../session';
import { formatTime } from '../../format';
import { useUi } from '../../hooks';
import { ClockIcon, NoteIcon, PlayIcon, SearchIcon, ShuffleIcon, SongIcon } from '../../icons';
import { AddGlyph, useJustAdded } from '../AddGlyph';
import { LibraryButton } from '../LibraryButton';
import { TrackListToolbar, useTrackListControls } from '../TrackListToolbar';
import { targetForContainer } from '../../catalogActions';
import { DEFAULT_PALETTE, extractPalette, type Rgb } from '../../palette';
import { pageTheme } from '../../theme';
import { usePublishPageTint } from '../../pageTint';
import '../home.css';
import {
  CatalogPageView,
  CatalogSectionView,
  CatalogSkeleton,
  ProviderPageFrame,
  routeForPlatform,
  useCatalogPage,
  type CatalogNav,
} from './catalog';
import { cleanIpcError } from './errors';
import './provider.css';

interface ProviderViewProps {
  nav: CatalogNav;
}

function useAuthorized(route: ReturnType<typeof routeForPlatform>): boolean {
  const caps = useUi((s) => s.capabilities);
  return route !== null && caps.find((c) => c.route === route)?.state === 'ready';
}

/** Home — Apple "Listen Now" when signed in, editorial browse otherwise. */
export function ProviderHomeView({ nav }: ProviderViewProps) {
  const platform = useUi((s) => s.platform);
  const route = routeForPlatform(platform);
  const { page, error, loading } = useCatalogPage(route, { kind: 'home' });
  return (
    <ProviderPageFrame title={platform === 'apple' ? 'Listen Now' : 'Home'} loading={loading} error={error} route={route}>
      {page && <CatalogPageView page={page} nav={nav} />}
    </ProviderPageFrame>
  );
}

export function ProviderBrowseView({ nav }: ProviderViewProps) {
  const platform = useUi((s) => s.platform);
  const route = routeForPlatform(platform);
  const { page, error, loading } = useCatalogPage(route, { kind: 'browse' });
  return (
    <ProviderPageFrame title="Browse" loading={loading} error={error} route={route}>
      {page && <CatalogPageView page={page} nav={nav} />}
    </ProviderPageFrame>
  );
}

export function ProviderRadioView({ nav }: ProviderViewProps) {
  const platform = useUi((s) => s.platform);
  const route = routeForPlatform(platform);
  const { page, error, loading } = useCatalogPage(route, { kind: 'radio' });
  return (
    <ProviderPageFrame title="Radio" loading={loading} error={error} route={route}>
      {page && <CatalogPageView page={page} nav={nav} />}
    </ProviderPageFrame>
  );
}

const LIBRARY_TABS = ['songs', 'albums', 'artists', 'playlists'] as const;
type LibraryTab = (typeof LIBRARY_TABS)[number];
const TAB_LABELS: Record<LibraryTab, string> = {
  songs: 'Songs',
  albums: 'Albums',
  artists: 'Artists',
  playlists: 'Playlists',
};

/** The user's streaming library — songs, albums, artists, playlists. */
export function ProviderLibraryView({ nav }: ProviderViewProps) {
  const platform = useUi((s) => s.platform);
  const route = routeForPlatform(platform);
  const authorized = useAuthorized(route);
  const [tab, setTab] = useState<LibraryTab>('songs');
  const [pages, setPages] = useState<CatalogEntry[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const query = useUi((s) => s.libraryQuery);

  useEffect(() => {
    let live = true;
    setPages([]);
    setNextOffset(null);
    setError(null);
    if (route === null || !authorized || !api.catalog) {
      setLoading(false);
      return;
    }
    setLoading(true);
    api.catalog
      .query(route, { kind: 'library', collection: tab, limit: 50 })
      .then((page) => {
        if (!live) return;
        const entries = page.sections.flatMap((s) => s.entries);
        setPages(entries);
        setNextOffset(page.nextOffset ?? null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError(cleanIpcError(e));
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [route, authorized, tab]);

  const loadMore = () => {
    if (route === null || nextOffset === null || !api.catalog) return;
    setLoading(true);
    api.catalog
      .query(route, { kind: 'library', collection: tab, limit: 50, offset: nextOffset })
      .then((page) => {
        setPages((prev) => [...prev, ...page.sections.flatMap((s) => s.entries)]);
        setNextOffset(page.nextOffset ?? null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setError(cleanIpcError(e));
        setLoading(false);
      });
  };

  const q = query.trim().toLowerCase();
  const filtered = q
    ? pages.filter((e) => {
        const text =
          e.kind === 'song'
            ? `${e.track.title} ${e.track.artists.map((a) => a.name).join(' ')}`
            : e.kind === 'album'
              ? `${e.album.title} ${e.album.subtitle ?? ''}`
              : e.kind === 'playlist'
                ? `${e.playlist.title} ${e.playlist.subtitle ?? ''}`
                : e.kind === 'artist'
                  ? e.artist.name
                  : e.station.name;
        return text.toLowerCase().includes(q);
      })
    : pages;
  const songTracks = filtered
    .filter((e): e is Extract<CatalogEntry, { kind: 'song' }> => e.kind === 'song')
    .map((e) => e.track);

  return (
    <div className="home-view">
      <div className="home-scroll">
        <header className="home-intro">
          <h1>Library</h1>
        </header>
        <nav className="src-pills catalog-tabs" aria-label="Library sections">
          {LIBRARY_TABS.map((t) => (
            <button
              key={t}
              className={`src-pill ${tab === t ? 'on' : ''}`}
              onClick={() => setTab(t)}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </nav>
        {!authorized && (
          <div className="home-empty">
            <span className="home-empty-icon"><NoteIcon size={28} /></span>
            <div>
              <h2>Sign in to see your library</h2>
              <p>Your streaming library appears here once you are signed in.</p>
              {route && (
                <button className="btn src-signin" onClick={() => session.signInRoute(route)}>
                  Sign in
                </button>
              )}
            </div>
          </div>
        )}
        {authorized && loading && pages.length === 0 && (
          <CatalogSkeleton label="Loading your library" />
        )}
        {authorized && error && (
          <div className="home-empty" role="alert">
            <span className="home-empty-icon"><NoteIcon size={28} /></span>
            <div><h2>Could not load your library</h2><p>{error}</p></div>
          </div>
        )}
        {authorized && !error && pages.length > 0 && (
          <CatalogSectionView
            id="library"
            title={TAB_LABELS[tab]}
            entries={filtered}
            nav={nav}
          />
        )}
        {authorized && !loading && !error && pages.length === 0 && (
          <div className="home-empty" role="status">
            <span className="home-empty-icon"><NoteIcon size={28} /></span>
            <div><h2>Nothing saved yet</h2><p>Music you add to your library will show up here.</p></div>
          </div>
        )}
        {authorized && tab === 'songs' && songTracks.length > 0 && (
          <p className="catalog-count">{songTracks.length} songs</p>
        )}
        {nextOffset !== null && (
          <button className="btn catalog-more" disabled={loading} onClick={loadMore}>
            {loading ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </div>
  );
}

/** Catalog search — grouped results across songs, albums, artists, playlists. */
export function ProviderSearchView({ nav, query, nonce }: ProviderViewProps & { query?: string | undefined; nonce?: number | undefined }) {
  const platform = useUi((s) => s.platform);
  const route = routeForPlatform(platform);
  const [text, setText] = useState(query ?? '');
  const [debounced, setDebounced] = useState(text);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The sidebar carries its query in the search location — adopt it. A new
  // submission (new query or nonce) applies immediately: an explicit submit
  // shouldn't wait out the typing debounce. An absent query clears the field
  // (Back, blank Search).
  useEffect(() => {
    const q = query ?? '';
    setText(q);
    setDebounced(q.trim());
  }, [query, nonce]);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDebounced(text.trim()), 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [text]);

  const request: CatalogRequest | null = debounced ? { kind: 'search', text: debounced, limit: 10 } : null;
  // nonce in deps: resubmitting an unchanged query must retry the fetch —
  // the serialized request is identical, so reqKey alone wouldn't refetch.
  const { page, error, loading } = useCatalogPage(route, request, [nonce]);

  return (
    <div className="home-view">
      <div className="home-scroll">
        <header className="home-intro"><h1>Search</h1></header>
        <div className="src-field catalog-search-field">
          <SearchIcon size={16} />
          <input
            type="search"
            placeholder="Search Apple Music"
            aria-label="Search the streaming catalog"
            autoFocus
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
          />
        </div>
        {loading && <CatalogSkeleton label="Searching" />}
        {!loading && error && (
          <div className="home-empty" role="alert">
            <span className="home-empty-icon"><NoteIcon size={28} /></span>
            <div><h2>Search failed</h2><p>{error}</p></div>
          </div>
        )}
        {!loading && !error && page && <CatalogPageView page={page} nav={nav} />}
        {!loading && !error && !page && !debounced && (
          <div className="home-empty"><div><h2>Search the catalog</h2><p>Songs, albums, artists, playlists and radio.</p></div></div>
        )}
      </div>
    </div>
  );
}

/** Album/playlist detail — driven by the catalog, styled like AlbumView. */
export function CatalogDetailView({ container, nav }: ProviderViewProps & {
  container: CatalogContainer;
}) {
  const request: CatalogRequest = container.isLibraryItem
    ? { kind: 'libraryDetail', collection: container.kind === 'album' ? 'albums' : 'playlists', id: container.id }
    : { kind: container.kind, id: container.id };
  const { page, error, loading } = useCatalogPage(container.route, request);
  const [palette, setPalette] = useState<Rgb[]>(DEFAULT_PALETTE);
  const queued = useJustAdded();

  const artworkUrl = page?.artwork?.url ?? container.artwork?.url;
  useEffect(() => {
    let live = true;
    if (!artworkUrl) {
      setPalette(DEFAULT_PALETTE);
      return;
    }
    void extractPalette(artworkUrl).then((p) => {
      if (live) setPalette(p ?? DEFAULT_PALETTE);
    });
    return () => {
      live = false;
    };
  }, [artworkUrl]);

  const tracks = useMemo<TrackRef[]>(
    () => page?.sections.flatMap((s) => s.entries).flatMap((e) => (e.kind === 'song' ? [e.track] : [])) ?? [],
    [page],
  );
  const { shown, controls } = useTrackListControls(tracks);
  const shownEntries = useMemo<CatalogEntry[]>(() => shown.map((track) => ({ kind: 'song', track })), [shown]);
  const totalDuration = tracks.reduce((sum, t) => sum + t.durationMs, 0);
  // The page wears this cover's colours: the flood, Play and the playing row.
  const pageStyle = useMemo(() => pageTheme(palette), [palette]);
  usePublishPageTint(pageStyle);
  const byline = page?.subtitle ?? container.subtitle;
  const origin = { kind: container.kind, id: container.id, name: container.title } as const;

  const shuffledPlay = () => {
    const items = [...tracks];
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    session.playTracks(items, 0, origin);
  };

  return (
    <div className="album album-page" style={pageStyle}>
      <div className="stage-scroll album-scroll">
        <section className="album-hero">
          <div className="album-art">
            {artworkUrl
              ? <img src={artworkUrl} alt={`${container.title} artwork`} draggable={false} />
              : <NoteIcon size={58} />}
          </div>
          <div className="album-info">
            <h1>{page?.title ?? container.title}</h1>
            {byline && (
              <div className="album-byline">
                <span className="album-avatar" aria-hidden="true">
                  {artworkUrl ? <img src={artworkUrl} alt="" /> : byline.slice(0, 1)}
                </span>
                <span>{byline}</span>
              </div>
            )}
            <div className="album-chips" aria-label="Details">
              <span className="chip"><NoteIcon size={12} />{container.kind === 'album' ? 'Album' : 'Playlist'}</span>
              {container.year !== undefined && <span className="chip"><ClockIcon size={12} />{container.year}</span>}
              <span className="chip">
                <SongIcon size={12} />
                {page?.truncated ? `First ${tracks.length} tracks` : `${tracks.length || container.itemCount || 0} tracks`}
              </span>
              {totalDuration > 0 && <span className="chip">{formatTime(totalDuration)}</span>}
            </div>
            <div className="album-actions">
              <button className="round-btn album-round" aria-label="Shuffle" title="Shuffle" disabled={!tracks.length} onClick={shuffledPlay}>
                <ShuffleIcon size={18} />
              </button>
              <button className="play-pill album-play-pill" disabled={!tracks.length} onClick={() => session.playTracks(tracks, 0, origin)}>
                <PlayIcon size={17} /> Play
              </button>
              <button className="round-btn album-round" aria-label="Add to queue" title={queued.added ? 'Added to queue' : 'Add to queue'} disabled={!tracks.length}
                onClick={() => {
                  tracks.forEach((t) => session.append(t));
                  queued.flash();
                }}>
                <AddGlyph added={queued.added} size={18} />
              </button>
              <LibraryButton target={targetForContainer(container)} className="round-btn album-round" size={18} />
            </div>
          </div>
        </section>
        <section className="album-tracklist" aria-label={`${container.title} track list`}>
          {loading && <CatalogSkeleton label="Loading tracks" rows />}
          {!loading && error && <div className="album-track-status" role="alert">{error}</div>}
          {!loading && !error && tracks.length === 0 && (
            <div className="album-track-status">No tracks on this {container.kind}.</div>
          )}
          {!loading && !error && tracks.length > 0 && <TrackListToolbar {...controls} />}
          {!loading && !error && tracks.length > 0 && shown.length === 0 && <p className="list-empty">No tracks match.</p>}
          {!loading && !error && <CatalogSectionView id="tracks" title="Tracks" entries={shownEntries} nav={nav} />}
        </section>
      </div>
    </div>
  );
}

/** Artist page — header + sections (top songs, albums, similar). */
export function ArtistView({ artist, nav }: ProviderViewProps & {
  artist: CatalogArtist;
}) {
  const { page, error, loading } = useCatalogPage(artist.route, { kind: 'artist', id: artist.id });
  const topTracks =
    page?.sections.find((s) => s.id === 'artist-top-songs')?.entries
      .filter((e): e is Extract<CatalogEntry, { kind: 'song' }> => e.kind === 'song')
      .map((e) => e.track) ?? [];

  return (
    <ProviderPageFrame title={artist.name} loading={loading} error={error} route={artist.route}>
      {topTracks.length > 0 && (
        <div className="album-actions artist-actions">
          <button className="play-pill" onClick={() => session.playTracks(topTracks, 0, { kind: 'provider', id: artist.id, name: artist.name })}>
            <PlayIcon size={16} /> <span>Play top songs</span>
          </button>
        </div>
      )}
      {page && <CatalogPageView page={page} nav={nav} />}
    </ProviderPageFrame>
  );
}

