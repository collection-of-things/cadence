import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LibraryAlbum } from '@cadence/protocol';
import { session } from './session';
import { recordPlayed } from './collection';
import { AlbumView } from './components/AlbumView';
import { FavoritesView } from './components/FavoritesView';
import { HomeView } from './components/HomeView';
import { LibraryView, type LibraryTab } from './components/LibraryView';
import { LyricsRail } from './components/LyricsRail';
import { NowPlayingFull } from './components/NowPlayingFull';
import { PlayerBar } from './components/PlayerBar';
import { QueuePanel } from './components/QueuePanel';
import { Sidebar } from './components/Sidebar';
import { SourcesView } from './components/SourcesView';
import { Toasts } from './components/Toasts';
import { TopBar } from './components/TopBar';
import { positionNow, useMediaSession, useUi } from './hooks';
import { extractPalette, DEFAULT_PALETTE } from './palette';

/** Where the browse stage is. The now-playing overlay is not a location. */
export type Location =
  | { page: 'home' }
  | { page: 'library'; tab: LibraryTab }
  | { page: 'favorites' }
  | { page: 'sources' }
  | { page: 'album'; album: LibraryAlbum };

const TABS_MAX = 6;

export function sameLocation(a: Location, b: Location): boolean {
  if (a.page !== b.page) return false;
  if (a.page === 'library' && b.page === 'library') return a.tab === b.tab;
  if (a.page === 'album' && b.page === 'album') return a.album.id === b.album.id;
  return true;
}

/** Identity of a location for page-change animation (re-mounts the page). */
function pageKey(location: Location): string {
  if (location.page === 'album') return `album:${location.album.id}`;
  // One key for every Library tab: search can switch tabs while typing, and
  // a remount would drop the query and focus.
  if (location.page === 'library') return 'library';
  return location.page;
}

export function App() {
  const view = useUi((s) => s.view);
  const viewNonce = useUi((s) => s.viewNonce);
  const hasTrack = useUi((s) => s.snapshot.current !== null);
  const expanded = useUi((s) => s.nowPlayingExpanded) && hasTrack;
  const track = useUi((s) => s.snapshot.current?.track);
  const [location, setLocation] = useState<Location>({ page: 'home' });
  const [backStack, setBackStack] = useState<Location[]>([]);
  const [forwardStack, setForwardStack] = useState<Location[]>([]);
  // Recently opened album pages, shown as tabs in the top bar.
  const [tabs, setTabs] = useState<LibraryAlbum[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const locationRef = useRef(location);
  locationRef.current = location;
  useMediaSession();

  useEffect(() => {
    if (!hasTrack && expanded) session.setNowPlayingExpanded(false);
  }, [hasTrack, expanded]);

  useEffect(() => {
    if (track) recordPlayed(track);
  }, [track]);

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
    if (sameLocation(next, current)) return;
    setBackStack((stack) => [...stack, current]);
    setForwardStack([]);
    setLocation(next);
    if (next.page === 'album') {
      const album = next.album;
      setTabs((list) => [...list.filter((a) => a.id !== album.id), album].slice(-TABS_MAX));
    }
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
          session.setQueueOpen(!s.queueOpen);
          break;
        case 'm':
        case 'M':
          session.toggleMute();
          break;
        case 'l':
        case 'L':
          if (s.snapshot.current) setRailOpen((open) => !open);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openAlbum = (album: LibraryAlbum) => navigate({ page: 'album', album });
  const openNowPlaying = () => session.setNowPlayingExpanded(true);
  const rail = railOpen && hasTrack;

  return (
    <div className={`app ${sidebarCollapsed ? 'sidebar-is-collapsed' : ''} ${rail ? 'has-rail' : ''}`}>
      <Sidebar location={location} collapsed={sidebarCollapsed} onNavigate={navigate} />
      <div className="stage">
        <TopBar
          location={location}
          tabs={tabs}
          canGoBack={backStack.length > 0}
          canGoForward={forwardStack.length > 0}
          sidebarCollapsed={sidebarCollapsed}
          railOpen={rail}
          onBack={goBack}
          onForward={goForward}
          onOpenAlbum={openAlbum}
          onToggleSidebar={() => setSidebarCollapsed((collapsed) => !collapsed)}
          onToggleRail={() => setRailOpen((open) => !open)}
        />
        <main className="stage-main">
          <div className="page" key={pageKey(location)}>
          {location.page === 'home' && <HomeView onSelectAlbum={openAlbum} />}
          {location.page === 'library' && (
            <LibraryView tab={location.tab} onSelectAlbum={openAlbum} onTab={(tab) => navigate({ page: 'library', tab })} />
          )}
          {location.page === 'favorites' && <FavoritesView />}
          {location.page === 'album' && <AlbumView key={location.album.id} album={location.album} />}
          {location.page === 'sources' && <SourcesView />}
          </div>
        </main>
        {!expanded && <PlayerBar onOpenNowPlaying={openNowPlaying} />}
      </div>
      {rail && <LyricsRail />}
      <QueuePanel />
      {expanded && createPortal(<NowPlayingFull onClose={() => session.setNowPlayingExpanded(false)} />, document.body)}
      {createPortal(<Toasts />, document.body)}
    </div>
  );
}
