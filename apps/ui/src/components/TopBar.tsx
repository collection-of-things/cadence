import { session } from '../app';
import { useUi } from '../hooks';
import { QueueIcon } from '../icons';
import { SettingsSheet } from './SettingsSheet';
import type { ShellPage } from './Sidebar';
import './shell.css';

type PrimaryPage = Extract<ShellPage, 'home' | 'library' | 'sources' | 'now'>;

interface TopBarProps {
  activePage: PrimaryPage;
  canGoBack: boolean;
  canGoForward: boolean;
  sidebarCollapsed: boolean;
  onBack(): void;
  onForward(): void;
  onNavigate(page: PrimaryPage): void;
  onToggleSidebar(): void;
}

function Arrow({ direction }: { direction: 'back' | 'forward' }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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

function SidebarGlyph({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d={collapsed ? 'M8.5 4.8v14.4' : 'M8.5 4.8v14.4'} stroke="currentColor" strokeWidth="1.6" />
      <path d={collapsed ? 'm12.2 9 3 3-3 3' : 'm15.8 9-3 3 3 3'} stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const tabs: { page: PrimaryPage; label: string }[] = [
  { page: 'home', label: 'Home' },
  { page: 'library', label: 'Library' },
  { page: 'sources', label: 'Sources' },
];

export function TopBar({ activePage, canGoBack, canGoForward, sidebarCollapsed, onBack, onForward, onNavigate, onToggleSidebar }: TopBarProps) {
  const queueOpen = useUi((s) => s.queueOpen);
  const queueCount = useUi((s) => s.queue.items.length);

  return (
    <header className="cadence-topbar">
      <div className="topbar-left">
        <div className="history-pill" aria-label="Navigation history">
          <button className="chrome-button" aria-label="Go back" title="Go back" disabled={!canGoBack} onClick={onBack}>
            <Arrow direction="back" />
          </button>
          <button className="chrome-button" aria-label="Go forward" title="Go forward" disabled={!canGoForward} onClick={onForward}>
            <Arrow direction="forward" />
          </button>
        </div>
        <button
          className={`chrome-button sidebar-toggle ${sidebarCollapsed ? 'is-on' : ''}`}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-pressed={sidebarCollapsed}
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={onToggleSidebar}
        >
          <SidebarGlyph collapsed={sidebarCollapsed} />
        </button>
      </div>

      <nav className="topbar-segments" aria-label="Primary navigation">
        {tabs.map((tab) => (
          <button
            key={tab.page}
            className={`topbar-segment ${activePage === tab.page ? 'is-active' : ''}`}
            aria-current={activePage === tab.page ? 'page' : undefined}
            onClick={() => onNavigate(tab.page)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="topbar-right">
        <button
          className={`chrome-button queue-toggle ${queueOpen ? 'is-on' : ''}`}
          aria-label="Toggle queue"
          aria-pressed={queueOpen}
          title="Queue"
          onClick={() => session.setQueueOpen(!queueOpen)}
        >
          <QueueIcon size={18} />
          {queueCount > 0 && <span className="topbar-queue-count">{queueCount}</span>}
        </button>
        <SettingsSheet />
      </div>
    </header>
  );
}
