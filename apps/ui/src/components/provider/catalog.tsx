/**
 * Provider catalog UI: the shared pieces that render Apple Music's world
 * (and later YouTube Music / Spotify) from the one CatalogPage shape. They
 * are built from the same shelf, card and track row as the local pages.
 */

import { useEffect, useState, type ReactNode } from 'react';
import type {
  ArtworkRef,
  CatalogArtist,
  CatalogContainer,
  CatalogEntry,
  CatalogPage,
  CatalogRequest,
  QueueItem,
  RouteId,
  TrackRef,
} from '@cadence/protocol';
import { stationToTrack } from '@cadence/protocol';
import { api, session } from '../../session';
import { useUi } from '../../hooks';
import { cleanIpcError } from '../../ipcError';
import { routeState } from '../../routes';
import { EmptyState, Shelf, ShelfTitle, SkeletonRows, SkeletonShelf, SquareCard } from '../Shelf';
import { TrackRow } from '../TrackRow';
import './provider.css';

export interface CatalogNav {
  openAlbum(container: CatalogContainer): void;
  openPlaylist(container: CatalogContainer): void;
  openArtist(artist: CatalogArtist): void;
}

type SongEntry = Extract<CatalogEntry, { kind: 'song' }>;
type CardEntry = Exclude<CatalogEntry, SongEntry>;

/** The tracks among a list of catalog entries, in order. */
export function songsOf(entries: readonly CatalogEntry[]): TrackRef[] {
  return entries.flatMap((e) => (e.kind === 'song' ? [e.track] : []));
}

/**
 * Fetch a CatalogPage for a request. Fetches again when the request or the
 * route's sign-in state changes, when `reload` is called, or when `deps`
 * change (for a retry of an identical request).
 */
export function useCatalogPage(
  route: RouteId | null,
  request: CatalogRequest | null,
  deps: unknown[] = [],
): { page: CatalogPage | null; error: string | null; loading: boolean; reload(): void } {
  const [page, setPage] = useState<CatalogPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const authorization = useUi((s) => routeState(s, route));
  const reqKey = request === null ? 'null' : JSON.stringify(request);
  useEffect(() => {
    let live = true;
    setPage(null);
    setError(null);
    if (route === null || request === null || !api.catalog) {
      setLoading(false);
      return;
    }
    setLoading(true);
    api.catalog
      .query(route, request)
      .then((p) => {
        if (!live) return;
        setPage(p);
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
    // `request` is compared by its serialised form (reqKey), not identity.
  }, [route, reqKey, nonce, authorization, ...deps]);
  return {
    page,
    error,
    loading,
    reload: () => setNonce((n) => n + 1),
  };
}

/** What a non-song entry shows on its card, and what picking it does. */
function cardOf(entry: CardEntry, nav: CatalogNav): { key: string; title: string; sub?: string | undefined; art: ArtworkRef | undefined; label: string; onOpen(): void } {
  switch (entry.kind) {
    case 'album': {
      const { album } = entry;
      return { key: `album:${album.id}`, title: album.title, sub: album.subtitle, art: album.artwork, label: `Open ${album.title}`, onOpen: () => nav.openAlbum(album) };
    }
    case 'playlist': {
      const { playlist } = entry;
      return { key: `playlist:${playlist.id}`, title: playlist.title, sub: playlist.subtitle, art: playlist.artwork, label: `Open ${playlist.title}`, onOpen: () => nav.openPlaylist(playlist) };
    }
    case 'artist': {
      const { artist } = entry;
      return { key: `artist:${artist.id}`, title: artist.name, art: artist.artwork, label: `Open ${artist.name}`, onOpen: () => nav.openArtist(artist) };
    }
    case 'station': {
      const { station } = entry;
      return {
        key: `station:${station.id}`,
        title: station.name,
        sub: station.subtitle,
        art: station.artwork,
        label: `Listen to ${station.name}`,
        onOpen: () => session.playTracks([stationToTrack(station)], 0, { kind: 'provider' }),
      };
    }
    default: {
      const _exhaustive: never = entry;
      return _exhaustive;
    }
  }
}

/** A list of catalog songs. Playing one queues the whole list from that song. */
export function SongList({ tracks, origin, nav, variant = 'song', albumArtist }: {
  tracks: TrackRef[];
  origin: QueueItem['origin'];
  nav: CatalogNav;
  /** 'album' drops the covers, for a page that already shows the one cover. */
  variant?: 'song' | 'album';
  albumArtist?: string | undefined;
}) {
  return (
    <div className="track-list">
      {tracks.map((track, i) => (
        <TrackRow
          key={track.id}
          track={track}
          index={i}
          variant={variant}
          albumArtist={albumArtist}
          nav={nav}
          onPlay={() => session.playTracks(tracks, i, origin)}
        />
      ))}
    </div>
  );
}

/** One catalog section: a track list for its songs, a card shelf for the rest. */
export function CatalogSectionView({ title, subtitle, entries, nav }: {
  title: string;
  subtitle?: string | undefined;
  entries: CatalogEntry[];
  nav: CatalogNav;
}) {
  if (!entries.length) return null;
  const songs = songsOf(entries);
  const cards = entries.filter((e): e is CardEntry => e.kind !== 'song');

  return (
    <>
      {songs.length > 0 && (
        <section className="shelf" aria-label={title}>
          <div className="shelf-head"><ShelfTitle title={title} subtitle={subtitle} /></div>
          <SongList tracks={songs} origin={{ kind: 'provider', name: title }} nav={nav} />
        </section>
      )}
      {cards.length > 0 && (
        <Shelf label={title} head={<ShelfTitle title={title} subtitle={subtitle} />}>
          {cards.map((entry, i) => {
            const { key, ...card } = cardOf(entry, nav);
            return <SquareCard key={key} {...card} eager={i <= 3} />;
          })}
        </Shelf>
      )}
    </>
  );
}

/** "Sign in" for a route; shown wherever a page needs an account. */
export function SignInButton({ route }: { route: RouteId }) {
  return (
    <button className="btn" onClick={() => session.signInRoute(route)}>
      Sign in
    </button>
  );
}

/** Every section of a catalog page, or a message when it came back empty. */
export function CatalogPageView({ page, nav }: { page: CatalogPage; nav: CatalogNav }) {
  if (page.sections.length === 0) return <EmptyState title="Nothing here yet" body="This page came back empty." />;
  return (
    <>
      {page.sections.map((s) => (
        <CatalogSectionView key={s.id} title={s.title} subtitle={s.subtitle} entries={s.entries} nav={nav} />
      ))}
    </>
  );
}

/**
 * The frame every provider page shares: a title, then whatever sits under it.
 * With `loading` or `error` it shows a skeleton or the failure instead of
 * the children; pages that manage those themselves leave them out.
 */
export function ProviderPageFrame({ title, loading = false, error = null, route, children }: {
  title: string;
  loading?: boolean;
  error?: string | null;
  /** Offers Sign in when the error is about the account. */
  route?: RouteId | null;
  children: ReactNode;
}) {
  return (
    <div className="stage-scroll home">
      <header className="page-head"><h1>{title}</h1></header>
      {loading && <CatalogSkeleton label={`Loading ${title}`} />}
      {!loading && error && (
        <EmptyState title={`Could not load ${title}`} body={error} alert>
          {route && /sign\s?in|authoriz|unauth/i.test(error) && <SignInButton route={route} />}
        </EmptyState>
      )}
      {!loading && !error && children}
    </div>
  );
}

/**
 * Static placeholder while a catalog page loads: card shelves by default,
 * song rows with `rows`. The label is for assistive tech only.
 */
export function CatalogSkeleton({ label, rows = false }: { label: string; rows?: boolean }) {
  return (
    <div role="status">
      <span className="sr-only">{label}</span>
      {rows ? <SkeletonRows /> : (
        <>
          <SkeletonShelf />
          <SkeletonShelf />
        </>
      )}
    </div>
  );
}
