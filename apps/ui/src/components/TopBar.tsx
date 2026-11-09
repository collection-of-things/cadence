import { useEffect, useRef } from 'react';
import type { Location } from '../App';
import { session } from '../session';
import { useUi } from '../hooks';
import { ChevronIcon, SearchIcon, SidebarIcon } from '../icons';
import { SettingsSheet } from './SettingsSheet';
import './shell.css';

interface TopBarProps {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack(): void;
  onForward(): void;
  onNavigate(next: Location): void;
  sidebarOpen: boolean;
  onToggleSidebar(): void;
}

const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');

/**
 * Top chrome over the stage, drawn as filled capsules: history (joined) and
 * the sidebar toggle on the left, the search field centred, settings on the
 * right. The bar doubles as the window's drag handle.
 */
export function TopBar({ canGoBack, canGoForward, onBack, onForward, onNavigate, sidebarOpen, onToggleSidebar }: TopBarProps) {
  const platform = useUi((s) => s.platform);
  const isApple = platform === 'apple';
  const inputRef = useRef<HTMLInputElement>(null);

  // Ctrl/Cmd + K jumps to search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openSearch = (query: string) => {
    if (isApple) {
      // The query rides the location — the search view mounts already submitted.
      onNavigate({ page: 'search', ...(query ? { query } : {}) });
      return;
    }
    session.setLibraryQuery(query);
    onNavigate({ page: 'library', tab: 'songs' });
  };

  return (
    <header className="topbar">
      <div className="topbar-group">
        <div className="topbar-history" role="group" aria-label="History">
          <button className="chrome-btn" aria-label="Go back" title="Back" disabled={!canGoBack} onClick={onBack}>
            <ChevronIcon dir="left" size={18} />
          </button>
          <button className="chrome-btn" aria-label="Go forward" title="Forward" disabled={!canGoForward} onClick={onForward}>
            <ChevronIcon dir="right" size={18} />
          </button>
        </div>
        <button
          className="chrome-btn"
          aria-label="Sidebar"
          aria-pressed={sidebarOpen}
          title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          onClick={onToggleSidebar}
        >
          <SidebarIcon size={18} />
        </button>
      </div>

      <label className="topbar-search">
        <SearchIcon size={16} />
        <input
          ref={inputRef}
          type="search"
          aria-label={isApple ? 'Search Apple Music' : 'Search your music'}
          placeholder="Search"
          autoComplete="off"
          spellCheck={false}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.currentTarget.value = '';
              event.currentTarget.blur();
              return;
            }
            if (event.key !== 'Enter') return;
            openSearch(event.currentTarget.value.trim());
            event.currentTarget.value = '';
            event.currentTarget.blur();
          }}
        />
        <span className="topbar-keys" aria-hidden="true">
          <span className="kbd">{isMac ? '⌘' : 'Ctrl'}</span>
          <span className="kbd">K</span>
        </span>
      </label>

      <div className="topbar-group">
        <SettingsSheet />
      </div>
    </header>
  );
}
