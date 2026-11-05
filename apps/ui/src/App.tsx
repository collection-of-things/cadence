import { useEffect, useRef, useState } from 'react';
import type { LibraryAlbum } from '@cadence/protocol';
import { session } from './app';
import { AlbumView } from './components/AlbumView';
import { HomeView } from './components/HomeView';
import { PlayerBar } from './components/PlayerBar';
import { LibraryView } from './components/LibraryView';
import { NowPlaying } from './components/NowPlaying';
import { QueuePanel } from './components/QueuePanel';
import { SettingsSheet } from './components/SettingsSheet';
import { Sidebar, type ShellPage } from './components/Sidebar';
import { SourcesView } from './components/SourcesView';
import { Toasts } from './components/Toasts';
import { TopBar } from './components/TopBar';
import { positionNow, useMediaSession, useUi } from './hooks';
import { extractPalette, DEFAULT_PALETTE } from './palette';

interface Location {
  page: ShellPage;
  album?: LibraryAlbum;
}

export function App() {
  const view = useUi((s) => s.view);
  const npExpanded = useUi((s) => s.nowPlayingExpanded);
  const artUrl = useUi((s) => s.snapshot.current?.track.artwork?.url);
  const [location, setLocation] = useState<Location>({ page: 'home' });
  const [backStack, setBackStack] = useState<Location[]>([]);
  const [forwardStack, setForwardStack] = useState<Location[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const previousStoreView = useRef(view);
  useMediaSession();

  useEffect(() => {
    previousStoreView.current = 'home';
    session.setView('home');
  }, []);

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

  useEffect(() => {
    if (previousStoreView.current === view) return;
    previousStoreView.current = view;
    setBackStack((stack) => [...stack, location]);
    setForwardStack([]);
    setLocation({ page: view });
  }, [view, location]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName ?? '';
      if (tag === 'TEXTAREA' || el?.isContentEditable) return;
      if (tag === 'INPUT') {
        const type = (el as HTMLInputElement).type;
        if (type !== 'range') return;
        if (e.key.startsWith('Arrow')) return;
      }
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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const navigate = (next: Location) => {
    setBackStack((stack) => [...stack, location]);
    setForwardStack([]);
    setLocation(next);
    if (next.page !== 'album' && next.page !== 'playlist') {
      previousStoreView.current = next.page;
      session.setView(next.page);
    }
  };

  const goBack = () => {
    const previous = backStack.at(-1);
    if (!previous) return;
    setBackStack((stack) => stack.slice(0, -1));
    setForwardStack((stack) => [...stack, location]);
    setLocation(previous);
    if (previous.page !== 'album' && previous.page !== 'playlist') {
      previousStoreView.current = previous.page;
      session.setView(previous.page);
    }
  };

  const goForward = () => {
    const next = forwardStack.at(-1);
    if (!next) return;
    setForwardStack((stack) => stack.slice(0, -1));
    setBackStack((stack) => [...stack, location]);
    setLocation(next);
    if (next.page !== 'album' && next.page !== 'playlist') {
      previousStoreView.current = next.page;
      session.setView(next.page);
    }
  };

  const openAlbum = (album: LibraryAlbum) => navigate({ page: 'album', album });
  const activePage = location.page === 'album' || location.page === 'playlist' ? 'library' : location.page;

  return (
    <div className={`app app-shell ${sidebarCollapsed ? 'sidebar-is-collapsed' : ''}`}>
      <Sidebar
        activePage={location.page === 'playlist' ? 'playlist' : activePage}
        collapsed={sidebarCollapsed}
        onNavigate={(page) => navigate({ page })}
      />
      <div className="shell-stage">
        <TopBar
          activePage={activePage}
          canGoBack={backStack.length > 0}
          canGoForward={forwardStack.length > 0}
          sidebarCollapsed={sidebarCollapsed}
          onBack={goBack}
          onForward={goForward}
          onNavigate={(page) => navigate({ page })}
          onToggleSidebar={() => setSidebarCollapsed((collapsed) => !collapsed)}
        />
        <main className="main shell-main">
          {location.page === 'home' && <HomeView onSelectAlbum={openAlbum} />}
          {location.page === 'library' && <LibraryView onSelectAlbum={openAlbum} />}
          {location.page === 'album' && location.album && (
            <AlbumView album={location.album} onBack={goBack} />
          )}
          {location.page === 'playlist' && <div className="home-view"><div className="home-scroll"><header className="home-intro"><h1>Playlists</h1></header><div className="home-empty"><div><h2>Playlists are coming soon</h2><p>Your playlists will appear here.</p></div></div></div></div>}
          {location.page === 'sources' && <SourcesView />}
          {location.page === 'now' && <NowPlaying />}
        </main>
      </div>
      {!npExpanded && <PlayerBar />}
      <QueuePanel />
      <Toasts />
    </div>
  );
}
