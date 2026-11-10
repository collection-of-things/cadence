/**
 * Provider pages, built from the shared catalog pieces. Apple Music gets the
 * full treatment today; other platforms slot in behind the same CatalogPage.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogArtist, CatalogContainer, CatalogEntry, CatalogRequest } from '@cadence/protocol';
import { api, session } from '../../session';
import { formatTime } from '../../format';
import { useUi } from '../../hooks';
import { ClockIcon, NoteIcon, PlayIcon, SearchIcon, ShuffleIcon, SongIcon } from '../../icons';
import { cleanIpcError } from '../../ipcError';
import { useCoverTheme } from '../../pageTint';
import { routeForPlatform, routeLabel, routeState } from '../../routes';
import { targetForContainer } from '../../catalogActions';
import { AddGlyph, useJustAdded } from '../AddGlyph';
import { LibraryButton } from '../LibraryButton';
import { EmptyState } from '../Shelf';
import { TrackListToolbar, useTrackListControls } from '../TrackListToolbar';
import '../home.css';
import {
  CatalogPageView,
  CatalogSectionView,
  CatalogSkeleton,
  ProviderPageFrame,
  SignInButton,
  SongList,
  songsOf,
  useCatalogPage,
  type CatalogNav,
} from './catalog';
import './provider.css';

interface ProviderViewProps {
  nav: CatalogNav;
}

const SHELF_TITLES = { home: 'Home', browse: 'Browse', radio: 'Radio' } as const;

/**
 * A page of catalog shelves for the active platform: `home` (Apple's Listen
 * Now when signed in, editorial browse otherwise), `browse` or `radio`.
 */
export function ProviderShelvesView({ nav, kind }: ProviderViewProps & { kind: keyof typeof SHELF_TITLES }) {
  const platform = useUi((s) => s.platform);
  const route = routeForPlatform(platform);
  const { page, error, loading } = useCatalogPage(route, { kind });
  const title = kind === 'home' && platform === 'apple' ? 'Listen Now' : SHELF_TITLES[kind];
  return (
    <ProviderPageFrame title={title} loading={loading} error={error} route={route}>
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
const LIBRARY_PAGE_SIZE = 50;

/** The user's streaming library: songs, albums, artists and playlists, a page at a time. */
export function ProviderLibraryView({ nav }: ProviderViewProps) {
  const platform = useUi((s) => s.platform);
  const route = routeForPlatform(platform);
  const authorized = useUi((s) => routeState(s, route) === 'ready');
  const [tab, setTab] = useState<LibraryTab>('songs');
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    setEntries([]);
    setNextOffset(null);
    setError(null);
    if (route === null || !authorized || !api.catalog) {
      setLoading(false);
      return;
    }
    setLoading(true);
    api.catalog
      .query(route, { kind: 'library', collection: tab, limit: LIBRARY_PAGE_SIZE })
      .then((page) => {
        if (!live) return;
        setEntries(page.sections.flatMap((s) => s.entries));
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
      .query(route, { kind: 'library', collection: tab, limit: LIBRARY_PAGE_SIZE, offset: nextOffset })
      .then((page) => {
        setEntries((prev) => [...prev, ...page.sections.flatMap((s) => s.entries)]);
        setNextOffset(page.nextOffset ?? null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setError(cleanIpcError(e));
        setLoading(false);
      });
  };

  const songCount = songsOf(entries).length;

  return (
    <ProviderPageFrame title="Library">
        <nav className="src-pills catalog-tabs" aria-label="Library sections">
          {LIBRARY_TABS.map((t) => (
            <button key={t} className={`src-pill ${tab === t ? 'on' : ''}`} aria-pressed={tab === t} onClick={() => setTab(t)}>
              {TAB_LABELS[t]}
            </button>
          ))}
        </nav>
        {!authorized && (
          <EmptyState title="Sign in to see your library" body="Your streaming library appears here once you are signed in.">
            {route && <SignInButton route={route} />}
          </EmptyState>
        )}
        {authorized && loading && entries.length === 0 && <CatalogSkeleton label="Loading your library" rows={tab === 'songs'} />}
        {authorized && error && <EmptyState title="Could not load your library" body={error} alert />}
        {authorized && !error && entries.length > 0 && (
          <CatalogSectionView title={TAB_LABELS[tab]} entries={entries} nav={nav} />
        )}
        {authorized && !loading && !error && entries.length === 0 && (
          <EmptyState title="Nothing saved yet" body="Music you add to your library will show up here." />
        )}
        {authorized && tab === 'songs' && songCount > 0 && (
          <p className="catalog-count">{songCount} {songCount === 1 ? 'song' : 'songs'}</p>
        )}
        {nextOffset !== null && (
          <button className="btn catalog-more" disabled={loading} onClick={loadMore}>
            {loading ? 'Loading…' : 'Load more'}
          </button>
        )}
    </ProviderPageFrame>
  );
}

/** Catalog search: grouped results across songs, albums, artists, playlists. */
export function ProviderSearchView({ nav, query, nonce }: ProviderViewProps & { query?: string | undefined; nonce?: number | undefined }) {
  const platform = useUi((s) => s.platform);
  const route = routeForPlatform(platform);
  const [text, setText] = useState(query ?? '');
  const [debounced, setDebounced] = useState(text);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The top bar carries its query in the search location; adopt it. A new
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
  // nonce in deps: resubmitting an unchanged query must retry the fetch.
  // The serialized request is identical, so it alone wouldn't refetch.
  const { page, error, loading } = useCatalogPage(route, request, [nonce]);

  return (
    <ProviderPageFrame title="Search">
        <div className="src-field catalog-search-field">
          <SearchIcon size={16} />
          <input
            type="search"
            placeholder={route ? `Search ${routeLabel(route)}` : 'Search'}
            aria-label="Search the streaming catalog"
            autoFocus
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
          />
        </div>
        {loading && <CatalogSkeleton label="Searching" />}
        {!loading && error && <EmptyState title="Search failed" body={error} alert />}
        {!loading && !error && page && <CatalogPageView page={page} nav={nav} />}
        {!loading && !error && !page && !debounced && (
          <EmptyState title="Search the catalog" body="Songs, albums, artists, playlists and radio." />
        )}
    </ProviderPageFrame>
  );
}

/** Album or playlist detail, driven by the catalog and laid out like AlbumView. */
export function CatalogDetailView({ container, nav }: ProviderViewProps & { container: CatalogContainer }) {
  const request: CatalogRequest = container.isLibraryItem
    ? { kind: 'libraryDetail', collection: container.kind === 'album' ? 'albums' : 'playlists', id: container.id }
    : { kind: container.kind, id: container.id };
  const { page, error, loading } = useCatalogPage(container.route, request);
  const queued = useJustAdded();

  const artworkUrl = page?.artwork?.url ?? container.artwork?.url;
  // The page wears this cover's colours: the flood, Play and the playing row.
  const pageStyle = useCoverTheme(artworkUrl);

  const tracks = useMemo(() => songsOf(page?.sections.flatMap((s) => s.entries) ?? []), [page]);
  const { shown, controls } = useTrackListControls(tracks);
  const totalDuration = tracks.reduce((sum, t) => sum + t.durationMs, 0);
  const byline = page?.subtitle ?? container.subtitle;
  const origin = { kind: container.kind, id: container.id, name: container.title } as const;
  const count = tracks.length || container.itemCount || 0;

  return (
    <div className="album" style={pageStyle}>
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
                {page?.truncated ? `First ${tracks.length} tracks` : `${count} ${count === 1 ? 'track' : 'tracks'}`}
              </span>
              {totalDuration > 0 && <span className="chip">{formatTime(totalDuration)}</span>}
            </div>
            <div className="album-actions">
              <button className="round-btn album-round" aria-label="Shuffle" title="Shuffle" disabled={!tracks.length} onClick={() => session.playShuffled(tracks, origin)}>
                <ShuffleIcon size={18} />
              </button>
              <button className="play-pill album-play-pill" disabled={!tracks.length} onClick={() => session.playTracks(tracks, 0, origin)}>
                <PlayIcon size={17} /> Play
              </button>
              <button className="round-btn album-round" aria-label="Add to queue" title={queued.added ? 'Added to queue' : 'Add to queue'} disabled={!tracks.length}
                onClick={() => {
                  session.append(tracks);
                  queued.flash();
                }}>
                <AddGlyph added={queued.added} size={18} />
              </button>
              <LibraryButton target={targetForContainer(container)} className="round-btn album-round" size={18} />
            </div>
          </div>
        </section>
        <section className="album-tracks" aria-label={`${container.title} tracks`}>
          {loading && <CatalogSkeleton label="Loading tracks" rows />}
          {!loading && error && <p className="list-empty" role="alert">{error}</p>}
          {!loading && !error && tracks.length === 0 && <p className="list-empty">No tracks on this {container.kind}.</p>}
          {!loading && !error && tracks.length > 0 && <TrackListToolbar {...controls} />}
          {!loading && !error && tracks.length > 0 && shown.length === 0 && <p className="list-empty">No tracks match.</p>}
          {!loading && !error && (
            <SongList
              tracks={shown}
              origin={origin}
              nav={nav}
              variant={container.kind === 'album' ? 'album' : 'song'}
              albumArtist={byline}
            />
          )}
        </section>
      </div>
    </div>
  );
}

/** Artist page: a Play button for the top songs, then the artist's sections. */
export function ArtistView({ artist, nav }: ProviderViewProps & { artist: CatalogArtist }) {
  const { page, error, loading } = useCatalogPage(artist.route, { kind: 'artist', id: artist.id });
  const topTracks = songsOf(page?.sections.find((s) => s.id === 'artist-top-songs')?.entries ?? []);

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
