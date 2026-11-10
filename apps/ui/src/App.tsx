import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LibraryAlbum } from '@cadence/protocol';
import { session } from './session';
import { recordPlayed } from './collection';
import { AlbumView } from './components/AlbumView';
import { FavoritesView } from './components/FavoritesView';
import { HomeView } from './components/HomeView';
import { LibraryView } from './components/LibraryView';
import { LocalArtistView } from './components/LocalArtistView';
import { NowPlayingFull } from './components/NowPlayingFull';
import { PlayerBar } from './components/PlayerBar';
import { SHELL_MOVE_MS, SidePanel, usePanelMounted, type PanelTab } from './components/SidePanel';
import { SettingsView } from './components/SettingsView';
import { Sidebar } from './components/Sidebar';
import { SourcesView } from './components/SourcesView';
import { Toasts } from './components/Toasts';
import { TopBar } from './components/TopBar';
import {
  ArtistView,
  CatalogDetailView,
  ProviderLibraryView,
  ProviderSearchView,
  ProviderShelvesView,
} from './components/provider/views';
import type { CatalogNav } from './components/provider/catalog';
import { positionNow, useMediaSession, useUi } from './hooks';
import { withoutMotion } from './instant';
import { pageKey, useNavigation } from './navigation';
import { usePageTint } from './pageTint';
import { useArtworkPalette } from './palette';
import { accentRgb, prefs, usePrefs } from './prefs';
import { useSidebarOpen } from './sidebarOpen';
import { applyTheme, themeFromPalette } from './theme';
import { Ambient } from './visuals/Ambient';

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
  const platform = useUi((s) => s.platform);
  const expanded = useUi((s) => s.nowPlayingExpanded && s.snapshot.current !== null);
  const track = useUi((s) => s.snapshot.current?.track);
  const { location, canGoBack, canGoForward, navigate, goBack, goForward } = useNavigation();
  const palette = useUi((s) => s.palette);
  const pageTint = usePageTint();
  const hasTrack = useUi((s) => s.snapshot.current !== null);
  const queueOpen = useUi((s) => s.queueOpen);
  const sidebar = useSidebarOpen();
  // The right panel: Up Next when the queue is open, otherwise lyrics.
  const [railOpen, setRailOpen] = useState(false);
  const railOpenRef = useRef(railOpen);
  useLayoutEffect(() => {
    railOpenRef.current = railOpen;
  }, [railOpen]);
  // L and the lyrics button: show lyrics, or close the panel if they already show.
  const toggleLyrics = useCallback(() => {
    const showing = railOpenRef.current && !session.store.getState().queueOpen;
    session.setQueueOpen(false);
    setRailOpen(!showing);
  }, []);
  useMediaSession();

  useEffect(() => {
    if (track) recordPlayed(track);
  }, [track]);

  // The artwork's colours tint the whole shell (and every portal); a fixed
  // accent from Settings replaces the artwork's own.
  const accent = usePrefs((p) => p.accent);
  useEffect(() => {
    applyTheme(themeFromPalette(palette, accentRgb(accent)));
  }, [palette, accent]);

  // The playing artwork's palette drives the theme above and the ambient field.
  const trackPalette = useArtworkPalette(track?.artwork?.url);
  useEffect(() => {
    session.setPalette(trackPalette);
  }, [trackPalette]);

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
          el?.closest?.('.q-row, .src-hit, [data-lyric], [role="button"], [role="menu"], button, a')) return;
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
      const s = session.store.getState();
      const skipMs = (e.shiftKey ? 30 : prefs.getState().skipSeconds) * 1000;
      switch (e.key) {
        case ' ':
          if (tag === 'BUTTON') return;
          e.preventDefault();
          session.togglePlay();
          break;
        case 'ArrowRight':
          session.seek(positionNow() + skipMs);
          break;
        case 'ArrowLeft':
          session.seek(positionNow() - skipMs);
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
  const openLocalArtist = (name: string) => navigate({ page: 'localartist', name });
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
  const [shownPanelTab, setShownPanelTab] = useState<PanelTab>(panelTab);
  if (panelOpen && shownPanelTab !== panelTab) setShownPanelTab(panelTab);
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
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onBack={goBack}
          onForward={goForward}
          onNavigate={navigate}
          settingsOpen={location.page === 'settings'}
          sidebarOpen={sidebar.open}
          onToggleSidebar={sidebar.toggle}
        />
        <main className="stage-main">
          {/* Keyed by platform: switching service cross-fades the stage. */}
          <div className="platform-fade" key={platform}>
          <div className="page" key={pageKey(location)}>
          {location.page === 'home' && (isApple ? <ProviderShelvesView kind="home" nav={catalogNav} /> : <HomeView onSelectAlbum={openAlbum} />)}
          {location.page === 'browse' && <ProviderShelvesView kind="browse" nav={catalogNav} />}
          {location.page === 'radio' && <ProviderShelvesView kind="radio" nav={catalogNav} />}
          {location.page === 'search' && (isApple ? <ProviderSearchView nav={catalogNav} query={location.query} nonce={location.nonce} /> : <SourcesView />)}
          {location.page === 'library' && (isApple ? (
            <ProviderLibraryView nav={catalogNav} />
          ) : (
            <LibraryView
              tab={location.tab}
              query={location.query}
              nonce={location.nonce}
              onSelectAlbum={openAlbum}
              onSelectArtist={openLocalArtist}
              onTab={(tab) => navigate({ page: 'library', tab })}
            />
          ))}
          {location.page === 'localfiles' && (
            <LibraryView tab={location.tab} onSelectAlbum={openAlbum} onSelectArtist={openLocalArtist} onTab={(tab) => navigate({ page: 'localfiles', tab })} />
          )}
          {location.page === 'favorites' && <FavoritesView />}
          {location.page === 'album' && <AlbumView key={location.album.id} album={location.album} />}
          {location.page === 'localartist' && <LocalArtistView name={location.name} onSelectAlbum={openAlbum} />}
          {location.page === 'detail' && (
            <CatalogDetailView container={location.container} nav={catalogNav} />
          )}
          {location.page === 'artist' && (
            <ArtistView artist={location.artist} nav={catalogNav} />
          )}
          {location.page === 'sources' && <SourcesView />}
          {location.page === 'settings' && (
            <SettingsView section={location.section} onSection={(section) => navigate({ page: 'settings', section })} />
          )}
          </div>
          </div>
        </main>
      </div>
      {panelMounted && <SidePanel open={panelOpen} tab={shownPanelTab} onTab={showTab} onClose={closePanel} />}
      {expanded && createPortal(<NowPlayingFull onClose={closeNowPlaying} location={location} onNavigate={navigate} panelShown={panelShown} />, document.body)}
      {createPortal(<Toasts />, document.body)}
    </div>
    <Ambient />
    </>
  );
}
