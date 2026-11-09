/**
 * Provider catalog UI — the shared machinery that renders Apple Music's world
 * (and later YouTube Music / Spotify) through the one CatalogPage surface.
 *
 * Deliberately reuses the shell's existing visual language (.home-*, .src-*,
 * .album-*) — Screen owns the design system; this file only supplies data.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CatalogArtist,
  CatalogContainer,
  CatalogEntry,
  CatalogPage,
  CatalogRequest,
  CatalogStation,
  RouteId,
  PlatformId,
  TrackRef,
} from '@cadence/protocol';
import { stationToTrack } from '@cadence/protocol';
import { api, session } from '../../session';
import { artistsLine, formatTime } from '../../format';
import { useUi } from '../../hooks';
import { NoteIcon, PlayIcon } from '../../icons';
import { AddGlyph, useJustAdded } from '../AddGlyph';
import { TrackMenu } from '../TrackRow';
import { cleanIpcError } from './errors';
import './provider.css';

/** Platform -> its playback route. */
export function routeForPlatform(platform: PlatformId): RouteId | null {
  if (platform === 'apple') return 'apple-musickit';
  if (platform === 'youtube') return 'youtube-music';
  if (platform === 'spotify') return 'spotify-web';
  return null;
}

export interface CatalogNav {
  openAlbum(container: CatalogContainer): void;
  openPlaylist(container: CatalogContainer): void;
  openArtist(artist: CatalogArtist): void;
}

/** Fetch a CatalogPage for a request; refetches when the request changes. */
export function useCatalogPage(
  route: RouteId | null,
  request: CatalogRequest | null,
  deps: unknown[] = [],
): { page: CatalogPage | null; error: string | null; loading: boolean; reload(): void } {
  const [page, setPage] = useState<CatalogPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const authorization = useUi((s) => s.capabilities.find((cap) => cap.route === route)?.state);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, reqKey, nonce, authorization, ...deps]);
  return {
    page,
    error,
    loading,
    reload: () => setNonce((n) => n + 1),
  };
}

// --- entry renderers ---------------------------------------------------------

function Arrow({ direction }: { direction: 'back' | 'forward' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d={direction === 'back' ? 'm14.8 5.5-6.5 6.5 6.5 6.5' : 'm9.2 5.5 6.5 6.5-6.5 6.5'}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Card({ art, title, sub, onOpen, onPlay, index }: {
  art?: { url: string } | null;
  title: string;
  sub?: string;
  onOpen?(): void;
  onPlay?(): void;
  index: number;
}) {
  return (
    <button className="home-album-card" onClick={onOpen ?? onPlay} aria-label={title}>
      <span className="home-cover">
        {art ? <img src={art.url} alt="" loading={index > 3 ? 'lazy' : 'eager'} /> : (
          <span className="home-cover-empty"><NoteIcon size={36} /></span>
        )}
        <span className="home-cover-shade" />
        <span className="home-card-open" aria-hidden="true"><Arrow direction="forward" /></span>
      </span>
      <span className="home-card-caption">
        <span className="home-card-title">{title}</span>
        {sub && <span className="home-card-artist">{sub}</span>}
      </span>
    </button>
  );
}

function SongRow({ track, index, tracks, origin, nav }: {
  track: TrackRef;
  index: number;
  tracks: TrackRef[];
  origin?: { kind: 'album' | 'playlist' | 'manual' | 'provider'; id?: string; name?: string };
  nav: CatalogNav;
}) {
  const isCurrent = useUi((s) => s.snapshot.current?.track.id === track.id);
  const playing = useUi((s) => s.snapshot.status === 'playing');
  const play = () => session.playTracks(tracks, index, origin ?? { kind: 'provider' });
  const { added, flash } = useJustAdded();
  return (
    <div
      className={`album-track-row ${isCurrent ? 'now' : ''}`}
      tabIndex={0}
      onClick={play}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          play();
        }
      }}
    >
      <span className="album-track-index">
        {isCurrent
          ? <span className={`q-eq ${playing ? 'on' : ''}`} aria-hidden="true"><i /><i /><i /></span>
          : String(index + 1).padStart(2, '0')}
      </span>
      <span className="home-cover catalog-song-art">
        {track.artwork ? <img src={track.artwork.url} alt="" loading="lazy" /> : (
          <span className="home-cover-empty"><NoteIcon size={16} /></span>
        )}
      </span>
      <span className="album-track-copy">
        <span className="album-track-title">{track.title}</span>
        <span className="album-track-artist">{artistsLine(track.artists)}</span>
      </span>
      <span className="album-track-duration">{formatTime(track.durationMs)}</span>
      <button
        className="album-track-add"
        aria-label={`Play ${track.title} next`}
        title={added ? 'Plays next' : 'Play next'}
        onClick={(e) => {
          e.stopPropagation();
          session.insertNext(track);
          flash();
        }}
      >
        <AddGlyph added={added} />
      </button>
      <TrackMenu track={track} nav={nav} />
    </div>
  );
}

/** One catalog section — a card rail for containers, a track list for songs. */
export function CatalogSectionView({ id, title, subtitle, entries, nav }: {
  id: string;
  title: string;
  subtitle?: string;
  entries: CatalogEntry[];
  nav: CatalogNav;
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
  }, [updateEdges, entries]);
  const scroll = (direction: -1 | 1) => {
    const el = railRef.current;
    if (!el) return;
    const card = el.querySelector('.home-album-card') as HTMLElement | null;
    el.scrollBy({ left: direction * ((card?.offsetWidth ?? 260) + 14) * 2, behavior: 'smooth' });
  };

  const songs = entries.filter((e): e is Extract<CatalogEntry, { kind: 'song' }> => e.kind === 'song');
  const others = entries.filter((e) => e.kind !== 'song');
  if (!entries.length) return null;

  const openEntry = (e: CatalogEntry) => {
    if (e.kind === 'album') nav.openAlbum(e.album);
    else if (e.kind === 'playlist') nav.openPlaylist(e.playlist);
    else if (e.kind === 'artist') nav.openArtist(e.artist);
  };
  const playEntry = (e: CatalogEntry) => {
    if (e.kind === 'station') session.playTracks([stationToTrack(e.station)], 0, { kind: 'provider' });
  };

  return (
    <section className="home-shelf" aria-label={title} data-section-id={id}>
      <div className="home-shelf-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {others.length > 0 && (
          <div className="shelf-controls">
            <button className="shelf-arrow" aria-label={`Scroll ${title} left`} disabled={edges.left} onClick={() => scroll(-1)}>
              <Arrow direction="back" />
            </button>
            <button className="shelf-arrow" aria-label={`Scroll ${title} right`} disabled={edges.right} onClick={() => scroll(1)}>
              <Arrow direction="forward" />
            </button>
          </div>
        )}
      </div>
      {songs.length > 0 && (
        <div className="album-track-list catalog-track-list">
          {songs.map((e, i) => (
            <SongRow
              key={e.track.id}
              track={e.track}
              index={i}
              tracks={songs.map((s) => s.track)}
              origin={{ kind: 'provider', name: title }}
              nav={nav}
            />
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="home-rail" ref={railRef} onScroll={updateEdges}>
          {others.map((e, i) => {
            if (e.kind === 'album' || e.kind === 'playlist') {
              const c = e.kind === 'album' ? e.album : e.playlist;
              return (
                <Card
                  key={`${c.kind}:${c.id}`}
                  index={i}
                  title={c.title}
                  {...(c.subtitle ? { sub: c.subtitle } : {})}
                  {...(c.artwork ? { art: c.artwork } : {})}
                  onOpen={() => openEntry(e)}
                />
              );
            }
            if (e.kind === 'artist') {
              return (
                <Card
                  key={`artist:${e.artist.id}`}
                  index={i}
                  title={e.artist.name}
                  {...(e.artist.artwork ? { art: e.artist.artwork } : {})}
                  onOpen={() => openEntry(e)}
                />
              );
            }
            if (e.kind === 'station') {
              const s: CatalogStation = e.station;
              return (
                <Card
                  key={`station:${s.id}`}
                  index={i}
                  title={s.name}
                  {...(s.subtitle ? { sub: s.subtitle } : {})}
                  {...(s.artwork ? { art: s.artwork } : {})}
                  onPlay={() => playEntry(e)}
                />
              );
            }
            return null;
          })}
        </div>
      )}
    </section>
  );
}

/** A full catalog page — title + subtitle + sections. */
export function CatalogPageView({ page, nav }: { page: CatalogPage; nav: CatalogNav }) {
  return (
    <>
      {page.sections.map((s) => (
        <CatalogSectionView key={s.id} id={s.id} title={s.title} {...(s.subtitle ? { subtitle: s.subtitle } : {})} entries={s.entries} nav={nav} />
      ))}
      {page.sections.length === 0 && (
        <div className="home-empty" role="status">
          <span className="home-empty-icon"><NoteIcon size={28} /></span>
          <div><h2>Nothing here yet</h2><p>This page came back empty.</p></div>
        </div>
      )}
    </>
  );
}

/** Loading / error / ready wrapper shared by all provider pages. */
export function ProviderPageFrame({ title, loading, error, needsSignIn, route, children }: {
  title: string;
  loading: boolean;
  error: string | null;
  needsSignIn?: boolean;
  route: RouteId | null;
  children: React.ReactNode;
}) {
  return (
    <div className="home-view">
      <div className="home-scroll">
        <header className="home-intro"><h1>{title}</h1></header>
        {loading && <CatalogSkeleton label={`Loading ${title}`} />}
        {!loading && error && (
          <div className="home-empty" role="alert">
            <span className="home-empty-icon"><NoteIcon size={28} /></span>
            <div>
              <h2>Could not load {title}</h2>
              <p>{error}</p>
              {(needsSignIn || /sign\s?in|authoriz|unauth/i.test(error)) && route && (
                <button className="btn src-signin" onClick={() => session.signInRoute(route)}>
                  Sign in
                </button>
              )}
            </div>
          </div>
        )}
        {!loading && !error && children}
      </div>
    </div>
  );
}

/**
 * Static placeholder while a catalog page loads: card rails by default,
 * song rows with `rows`. The label is for assistive tech only.
 */
export function CatalogSkeleton({ label, rows = false }: { label: string; rows?: boolean }) {
  return (
    <div className="catalog-skeleton" role="status">
      <span className="sr-only">{label}</span>
      {rows ? (
        <div className="catalog-skeleton-rows" aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => <span key={i} className="skeleton skeleton-row" />)}
        </div>
      ) : (
        Array.from({ length: 2 }, (_, s) => (
          <div key={s} className="home-shelf" aria-hidden="true">
            <span className="skeleton catalog-skeleton-title" />
            <div className="home-rail">
              {Array.from({ length: 6 }, (_, i) => <span key={i} className="skeleton catalog-skeleton-card" />)}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/** Play affordance for a whole section of songs. */
export function PlayAllButton({ tracks, origin }: {
  tracks: TrackRef[];
  origin?: { kind: 'album' | 'playlist' | 'manual' | 'provider'; id?: string; name?: string };
}) {
  return (
    <button className="play-pill" disabled={!tracks.length} onClick={() => session.playTracks(tracks, 0, origin)}>
      <PlayIcon size={16} /> <span>Play</span>
    </button>
  );
}
