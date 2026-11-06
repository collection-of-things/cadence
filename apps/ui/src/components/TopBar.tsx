import type { LibraryAlbum } from '@cadence/protocol';
import type { Location } from '../App';
import { session } from '../session';
import { useUi } from '../hooks';
import { ChevronIcon, LyricsIcon, QueueIcon, SidebarIcon } from '../icons';
import { SettingsSheet } from './SettingsSheet';
import './shell.css';

interface TopBarProps {
  location: Location;
  tabs: LibraryAlbum[];
  canGoBack: boolean;
  canGoForward: boolean;
  sidebarCollapsed: boolean;
  railOpen: boolean;
  onBack(): void;
  onForward(): void;
  onOpenAlbum(album: LibraryAlbum): void;
  onToggleSidebar(): void;
  onToggleRail(): void;
}

/**
 * Top chrome over the stage: history + sidebar toggle on the left, recent
 * album tabs in the middle, lyrics / queue / settings on the right.
 */
export function TopBar(props: TopBarProps) {
  const { location, tabs, canGoBack, canGoForward, sidebarCollapsed, railOpen } = props;
  const hasTrack = useUi((s) => s.snapshot.current !== null);
  const queueOpen = useUi((s) => s.queueOpen);
  const queueCount = useUi((s) => s.queue.items.length);
  const activeAlbum = location.page === 'album' ? location.album.id : null;

  return (
    <header className="topbar">
      <div className="topbar-group">
        <div className="chrome-pill" aria-label="History">
          <button className="chrome-btn" aria-label="Go back" title="Back" disabled={!canGoBack} onClick={props.onBack}>
            <ChevronIcon dir="left" size={18} />
          </button>
          <span className="chrome-sep" aria-hidden="true" />
          <button className="chrome-btn" aria-label="Go forward" title="Forward" disabled={!canGoForward} onClick={props.onForward}>
            <ChevronIcon dir="right" size={18} />
          </button>
        </div>
        <button
          className={`chrome-btn chrome-solo ${sidebarCollapsed ? 'is-on' : ''}`}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-pressed={sidebarCollapsed}
          title="Sidebar"
          onClick={props.onToggleSidebar}
        >
          <SidebarIcon size={19} />
        </button>
      </div>

      <nav className="topbar-tabs" aria-label="Recent pages">
        {tabs.map((album) => (
          <button
            key={album.id}
            className={`page-tab ${album.id === activeAlbum ? 'is-active' : ''}`}
            aria-current={album.id === activeAlbum ? 'page' : undefined}
            title={`${album.title} — ${album.artist}`}
            onClick={() => props.onOpenAlbum(album)}
          >
            {album.title}
          </button>
        ))}
      </nav>

      <div className="topbar-group chrome-pill">
        <button
          className={`chrome-btn ${railOpen ? 'is-on' : ''}`}
          aria-label="Lyrics"
          aria-pressed={railOpen}
          title={hasTrack ? 'Lyrics (L)' : 'Play something to see lyrics'}
          disabled={!hasTrack}
          onClick={props.onToggleRail}
        >
          <LyricsIcon size={19} />
        </button>
        <button
          className={`chrome-btn ${queueOpen ? 'is-on' : ''}`}
          aria-label={`Queue, ${queueCount} ${queueCount === 1 ? 'track' : 'tracks'}`}
          aria-pressed={queueOpen}
          title="Queue (Q)"
          data-queue-toggle
          onClick={() => session.setQueueOpen(!queueOpen)}
        >
          <QueueIcon size={19} />
        </button>
        <SettingsSheet />
      </div>
    </header>
  );
}
