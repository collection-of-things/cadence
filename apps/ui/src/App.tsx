import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CatalogArtist, CatalogContainer, LibraryAlbum } from '@cadence/protocol';
import { session } from './session';
import { recordPlayed } from './collection';
import { AlbumView } from './components/AlbumView';
import { FavoritesView } from './components/FavoritesView';
import { HomeView } from './components/HomeView';
import { LibraryView, type LibraryTab } from './components/LibraryView';
import { NowPlayingFull } from './components/NowPlayingFull';
import { PlayerBar } from './components/PlayerBar';
import { SHELL_MOVE_MS, SidePanel, usePanelMounted, type PanelTab } from './components/SidePanel';
import { Sidebar } from './components/Sidebar';
import { SourcesView } from './components/SourcesView';
import { Toasts } from './components/Toasts';
import { TopBar } from './components/TopBar';
import {
  ArtistView,
  CatalogDetailView,
  ProviderBrowseView,
  ProviderHomeView,
  ProviderLibraryView,
  ProviderRadioView,
  ProviderSearchView,
} from './components/provider/views';
import type { CatalogNav } from './components/provider/catalog';
import { positionNow, useMediaSession, useUi } from './hooks';
import { withoutMotion } from './instant';
import { usePageTint } from './pageTint';
import { extractPalette, DEFAULT_PALETTE } from './palette';
import { useSidebarOpen } from './sidebarOpen';
import { applyTheme, themeFromPalette } from './theme';
import { Ambient } from './visuals/Ambient';

/** Where the browse stage is. The now-playing overlay is not a location. */
export type Location =
  | { page: 'home' }
  | { page: 'browse' }
  | { page: 'radio' }
  | { page: 'search'; query?: string; nonce?: number }
  | { page: 'library'; tab: LibraryTab }
  | { page: 'localfiles'; tab: LibraryTab }
  | { page: 'favorites' }
  | { page: 'sources' }
  | { page: 'album'; album: LibraryAlbum }
  | { page: 'detail'; container: CatalogContainer }
  | { page: 'artist'; artist: CatalogArtist };

export function sameLocation(a: Location, b: Location): boolean {
  if (a.page !== b.page) return false;
  if (a.page === 'search' && b.page === 'search') return a.query === b.query;
  if (a.page === 'library' && b.page === 'library') return a.tab === b.tab;
  if (a.page === 'localfiles' && b.page === 'localfiles') return a.tab === b.tab;
  if (a.page === 'album' && b.page === 'album') return a.album.id === b.album.id;
  if (a.page === 'detail' && b.page === 'detail') return a.container.id === b.container.id;
  if (a.page === 'artist' && b.page === 'artist') return a.artist.id === b.artist.id;
  return true;
}

/** Identity of a location for page-change animation (re-mounts the page). */
function pageKey(location: Location): string {
  if (location.page === 'album') return `album:${location.album.id}`;
  if (location.page === 'detail') return `detail:${location.container.id}`;
  if (location.page === 'artist') return `artist:${location.artist.id}`;
  // One key for every Library/Local Files tab: search can switch tabs while
  // typing, and a remount would drop the query and focus.
  if (location.page === 'library' || location.page === 'localfiles') return location.page;
  return location.page;
}

/**
 * True from the commit that changes the shell's shape until its slide ends.
 * Derived during render so the stage gets its transition in that same commit.
 */
function useShellMoving(shape: string): boolean {
  const [settled, setSettled] = useState(shape);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(shape), SHELL_MOVE_MS + 40);
    return () => clearTimeout(timer);
  }, [shape]);
  return shape !== settled;
}

export function App() {
  const view = useUi((s) => s.view);
  const viewNonce = useUi((s) => s.viewNonce);
  const platform = useUi((s) => s.platform);
  const expanded = useUi((s) => s.nowPlayingExpanded && s.snapshot.current !== null);
  const track = useUi((s) => s.snapshot.current?.track);
  const [location, setLocation] = useState<Location>({ page: 'home' });
  const [backStack, setBackStack] = useState<Location[]>([]);
  const [forwardStack, setForwardStack] = useState<Location[]>([]);
  const palette = useUi((s) => s.palette);
  const pageTint = usePageTint();
  const hasTrack = useUi((s) => s.snapshot.current !== null);
  const queueOpen = useUi((s) => s.queueOpen);
  const sidebar = useSidebarOpen();
  // The right panel: Up Next when the queue is open, otherwise lyrics.
  const [railOpen, setRailOpen] = useState(false);
  const railOpenRef = useRef(railOpen);
  railOpenRef.current = railOpen;
  // L and the lyrics button: show lyrics, or close the panel if they already show.
  const toggleLyrics = useCallback(() => {
    const showing = railOpenRef.current && !session.store.getState().queueOpen;
    session.setQueueOpen(false);
    setRailOpen(!showing);
  }, []);
  const locationRef = useRef(location);
  locationRef.current = location;
  const searchNonce = useRef(0);
  useMediaSession();

  useEffect(() => {
    if (track) recordPlayed(track);
  }, [track]);

  // The artwork's colours tint the whole shell (and every portal).
  useEffect(() => {
    applyTheme(themeFromPalette(palette));
  }, [palette]);

  const artUrl = track?.artwork?.url;
  useEffect(() => {
    let live = true;
    if (!artUrl) {
      session.setPalette(DEFAULT_PALETTE);
      return;
    }
    void extractPalette(artUrl).then((p) => {
      if (live) session.setPalette(p ?? DEFAULT_PALETTE);
    });
    return () => {
      live = false;
    };
  }, [artUrl]);

  const navigate = useCallback((next: Location) => {
    const current = locationRef.current;
    if (next.page === 'search') {
      // Every explicit submission lands — even a repeat of the current query —
      // so the view can reset its field to what was submitted. The nonce is
      // the submission signal; identical resubmits update in place rather than
      // growing the back stack.
      const target: Location = { ...next, nonce: ++searchNonce.current };
      if (!sameLocation(next, current)) {
        setBackStack((stack) => [...stack, current]);
        setForwardStack([]);
      }
      setLocation(target);
      return;
    }
    if (sameLocation(next, current)) return;
    setBackStack((stack) => [...stack, current]);
    setForwardStack([]);
    setLocation(next);
  }, []);

  // External view requests (store.setView from capture scripts, other
  // components): 'now' opens the overlay, the rest navigate.
  useEffect(() => {
    if (viewNonce === 0) return;
    if (view === 'now') session.setNowPlayingExpanded(true);
    else if (view === 'library') navigate({ page: 'library', tab: 'albums' });
    else navigate({ page: view });
  }, [viewNonce, view, navigate]);

  const goBack = () => {
    const previous = backStack.at(-1);
    if (!previous) return;
    setBackStack((stack) => stack.slice(0, -1));
    setForwardStack((stack) => [...stack, location]);
    setLocation(previous);
  };

  const goForward = () => {
    const next = forwardStack.at(-1);
    if (!next) return;
    setForwardStack((stack) => stack.slice(0, -1));
    setBackStack((stack) => [...stack, location]);
    setLocation(next);
  };

  useEffect(() => {
    // Buttons never take focus on mousedown, so Space stays play/pause.
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('button')) e.preventDefault();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName ?? '';
      if (tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      // Focusable containers own their Enter/Space; other keys still pass.
      if ((e.key === ' ' || e.key === 'Enter') &&
          el?.closest?.('.q-row, .tr-row, .track-row, .src-hit, [data-lyric], [role="button"], [role="menu"], button, a')) return;
      // Focused scrollable regions own their scrolling keys only.
      if ((e.key.startsWith('Arrow') || e.key === 'PageUp' || e.key === 'PageDown' || e.key === 'Home' || e.key === 'End') &&
          el?.closest?.('.lyrics-scroll, .queue, .lib, .stage-scroll, .src, .sidebar, .lyrics-rail')) return;
      // Volume lives behind Ctrl — plain arrows scroll.
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.ctrlKey) return;
      if (tag === 'INPUT') {
        const type = (el as HTMLInputElement).type;
        if (type !== 'range') return;
        if (e.key.startsWith('Arrow')) return;
      }
      if (document.querySelector('.sheet')) return; // sheet owns its own focus+keys
      const s = session.store.getState();
      switch (e.key) {
        case ' ':
          if (tag === 'BUTTON') return;
          e.preventDefault();
          session.togglePlay();
          break;
        case 'ArrowRight':
          session.seek(positionNow() + (e.shiftKey ? 30_000 : 5_000));
          break;
        case 'ArrowLeft':
          session.seek(positionNow() - (e.shiftKey ? 30_000 : 5_000));
          break;
        case 'ArrowUp':
          e.preventDefault();
          session.setVolume(s.snapshot.volume + 0.05);
          break;
        case 'ArrowDown':
          e.preventDefault();
          session.setVolume(s.snapshot.volume - 0.05);
          break;
        case 'q':
        case 'Q':
          withoutMotion(() => session.setQueueOpen(!s.queueOpen));
          break;
        case 'm':
        case 'M':
          session.toggleMute();
          break;
        case 'l':
        case 'L':
          if (s.snapshot.current) withoutMotion(toggleLyrics);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openAlbum = (album: LibraryAlbum) => navigate({ page: 'album', album });
  const openNowPlaying = () => session.setNowPlayingExpanded(true);
  const closeNowPlaying = useCallback(() => session.setNowPlayingExpanded(false), []);
  const catalogNav: CatalogNav = {
    openAlbum: (container) => navigate({ page: 'detail', container }),
    openPlaylist: (container) => navigate({ page: 'detail', container }),
    openArtist: (artist) => navigate({ page: 'artist', artist }),
  };
  const isApple = platform === 'apple';
  const panelTab: PanelTab = queueOpen ? 'queue' : 'lyrics';
  // Now Playing has its own Up Next, so the panel unmounts under it but keeps its space.
  const panelShown = queueOpen || (railOpen && hasTrack);
  const panelOpen = !expanded && panelShown;
  const lyricsShown = panelOpen && panelTab === 'lyrics';
  const panelMounted = usePanelMounted(panelOpen);
  // Closing the queue flips panelTab; the panel keeps its tab while it slides away.
  const shownPanelTab = useRef(panelTab);
  if (panelOpen) shownPanelTab.current = panelTab;
  const shellMoving = useShellMoving(`${sidebar.open}:${panelShown}`);
  const showTab = (tab: PanelTab) => {
    setRailOpen(tab === 'lyrics');
    session.setQueueOpen(tab === 'queue');
  };
  const closePanel = () => {
    setRailOpen(false);
    session.setQueueOpen(false);
  };

  return (
    <>
    <div
      className={`app ${expanded ? 'is-immersive' : ''} ${panelShown ? 'has-rail' : ''} ${shellMoving ? 'is-moving' : ''}`}
      data-svc={isApple ? 'apple' : 'local'}
      style={pageTint.active ? { '--shell-tint': pageTint.style?.['--acc'] } : undefined}
    >
      <Sidebar location={location} onNavigate={navigate} />
      <div className="stage">
        {pageTint.style && <div className={`page-wash ${pageTint.active ? 'is-on' : ''}`} style={pageTint.style} aria-hidden="true" />}
        {/* The transport must be the first play-named control in the document:
            page-level buttons ("Play album", "Play <track> next") legitimately
            share the name space, so the docked player leads DOM order. */}
        {!expanded && <PlayerBar placement="docked" lyricsOn={lyricsShown} onToggleLyrics={toggleLyrics} onToggleFullScreen={openNowPlaying} />}
        <TopBar
          canGoBack={backStack.length > 0}
          canGoForward={forwardStack.length > 0}
          onBack={goBack}
          onForward={goForward}
          onNavigate={navigate}
          sidebarOpen={sidebar.open}
          onToggleSidebar={sidebar.toggle}
        />
        <main className="stage-main">
          {/* Keyed by platform: switching service cross-fades the stage. */}
          <div className="platform-fade" key={platform}>
          <div className="page" key={pageKey(location)}>
          {location.page === 'home' && (isApple ? <ProviderHomeView nav={catalogNav} /> : <HomeView onSelectAlbum={openAlbum} />)}
          {location.page === 'browse' && <ProviderBrowseView nav={catalogNav} />}
          {location.page === 'radio' && <ProviderRadioView nav={catalogNav} />}
          {location.page === 'search' && (isApple ? <ProviderSearchView nav={catalogNav} query={location.query} nonce={location.nonce} /> : <SourcesView />)}
          {location.page === 'library' && (isApple ? (
            <ProviderLibraryView nav={catalogNav} />
          ) : (
            <LibraryView tab={location.tab} onSelectAlbum={openAlbum} onTab={(tab) => navigate({ page: 'library', tab })} />
          ))}
          {location.page === 'localfiles' && (
            <LibraryView tab={location.tab} onSelectAlbum={openAlbum} onTab={(tab) => navigate({ page: 'localfiles', tab })} />
          )}
          {location.page === 'favorites' && <FavoritesView />}
          {location.page === 'album' && <AlbumView key={location.album.id} album={location.album} />}
          {location.page === 'detail' && (
            <CatalogDetailView container={location.container} nav={catalogNav} />
          )}
          {location.page === 'artist' && (
            <ArtistView artist={location.artist} nav={catalogNav} />
          )}
          {location.page === 'sources' && <SourcesView />}
          </div>
          </div>
        </main>
      </div>
      {panelMounted && <SidePanel open={panelOpen} tab={shownPanelTab.current} onTab={showTab} onClose={closePanel} />}
      {expanded && createPortal(<NowPlayingFull onClose={closeNowPlaying} location={location} onNavigate={navigate} panelShown={panelShown} />, document.body)}
      {createPortal(<Toasts />, document.body)}
    </div>
    <Ambient />
    </>
  );
}
