import { session } from '../app';
import { useEffect, useState } from 'react';
import { SearchIcon } from '../icons';
import { useUi } from '../hooks';
import './shell.css';

export type ShellPage =
  | 'home'
  | 'browse'
  | 'radio'
  | 'search'
  | 'library'
  | 'localfiles'
  | 'sources'
  | 'now'
  | 'album'
  | 'playlist'
  | 'detail'
  | 'artist';

type NavSection = 'home' | 'browse' | 'radio' | 'search' | 'library' | 'localfiles' | 'sources' | 'apple';

function Glyph({ name, size = 17 }: { name: NavSection; size?: number }) {
  const common = { stroke: 'currentColor', strokeWidth: 1.65, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {name === 'home' && <><path d="m3.6 10.5 8.4-7 8.4 7" {...common} /><path d="M5.8 9.3v10.2h12.4V9.3M9.4 19.5v-6h5.2v6" {...common} /></>}
      {name === 'browse' && <><circle cx="12" cy="12" r="8.4" {...common} /><path d="m15.4 8.6-2 4.8-4.8 2 2-4.8Z" {...common} /></>}
      {name === 'radio' && <><rect x="4" y="9" width="16" height="10" rx="2" {...common} /><path d="m5.4 9 11-4.4M9 14.6h.01M12 14.6h6M9 17h.01M12 17h6" {...common} /></>}
      {name === 'search' && <><circle cx="11" cy="11" r="6.4" {...common} /><path d="m16 16 4.4 4.4" {...common} /></>}
      {name === 'library' && <><path d="M4 5.2h16M4 9.8h16M4 14.4h10" {...common} /><path d="M4 19h8" {...common} /><circle cx="18" cy="17.6" r="2.8" {...common} /></>}
      {name === 'localfiles' && <><path d="M4 7.2 8.4 5h7.2l4.4 2.2v10.4a1.4 1.4 0 0 1-1.4 1.4H5.4A1.4 1.4 0 0 1 4 17.6Z" {...common} /><path d="M4 9.8h16M9.4 14.4v3.4a1.8 1.8 0 1 1-1.4-1.75M15 13v3.4a1.8 1.8 0 1 1-1.4-1.75" {...common} /></>}
      {name === 'sources' && <><path d="M5 8.2h14a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7.6a2 2 0 0 1 2-2Z" {...common} /><path d="M8 8.2V6.6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v1.6M12 12v4" {...common} /></>}
      {name === 'apple' && <><path d="M15.8 5.2c-.8.9-2 1.5-3.1 1.5-.2-1.2.4-2.4 1.2-3.1.8-.8 2.1-1.4 3.1-1.4.1 1.2-.4 2.2-1.2 3ZM12.7 8.2c.9 0 1.9.7 2.4.7s1.6-.8 3-.8c1.3 0 2.4.7 3.1 1.9-1.4.8-2.1 2-2.1 3.3 0 1.8 1.1 3 2.4 3.4-.2.5-.4 1-.7 1.5-.8 1.3-1.8 2.6-3.1 2.6-.9 0-1.2-.6-2.4-.6s-1.6.6-2.4.6c-1.3 0-2.3-1.4-3.1-2.7C8.6 16.4 7.7 14 7.7 11.9c0-3 1.9-4.5 3.7-4.5Z" {...common} /></>}
    </svg>
  );
}

interface SidebarProps {
  activePage: ShellPage;
  collapsed: boolean;
  onNavigate(page: Exclude<ShellPage, 'album' | 'playlist' | 'detail' | 'artist'>): void;
}

export function Sidebar({ activePage, collapsed, onNavigate }: SidebarProps) {
  const platform = useUi((s) => s.platform);
  const capabilities = useUi((s) => s.capabilities);
  const appleCap = capabilities.find((c) => c.route === 'apple-musickit');
  const needsAppleSignIn = platform === 'apple' && appleCap !== undefined && appleCap.state !== 'ready';
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 690px)').matches);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 690px)');
    const update = () => setCompact(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const navRow = (target: Exclude<ShellPage, 'album' | 'playlist' | 'detail' | 'artist'>, label: string, icon: NavSection) => {
    const isActive = activePage === target;
    return (
      <button
        key={target}
        className={`sidebar-nav-row ${isActive ? 'is-active' : ''}`}
        aria-current={isActive ? 'page' : undefined}
        title={collapsed ? label : undefined}
        onClick={() => onNavigate(target)}
      >
        <span className="sidebar-row-icon"><Glyph name={icon} size={16} /></span>
        {!collapsed && <span className="sidebar-row-label">{label}</span>}
      </button>
    );
  };

  const searchTarget = platform === 'local' ? 'library' : 'search';

  return (
    <aside className={`sidebar ${collapsed ? 'is-collapsed' : ''}`} aria-label="Main sidebar">
      <div className="sidebar-brand">
        <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
        {!collapsed && <span className="sidebar-brand-name">cadence</span>}
      </div>

      <label className="sidebar-search">
        <SearchIcon size={16} />
        {!collapsed && <input aria-label="Search Cadence" placeholder={platform === 'apple' ? 'Search Apple Music' : 'Search your music'} onKeyDown={(event) => {
          if (event.key === 'Enter') {
            session.setLibraryQuery(event.currentTarget.value.trim());
            onNavigate(searchTarget);
          }
        }} />}
        {collapsed && <span className="sidebar-search-tooltip">Search</span>}
        {(collapsed || compact) && (
          <button
            className="sidebar-compact-search-hit"
            aria-label="Search your music"
            onClick={() => {
              session.setLibraryQuery('');
              onNavigate(searchTarget);
              setTimeout(() => (document.querySelector<HTMLElement>('.lib-search input') ?? document.querySelector<HTMLElement>('.lib-bar input') ?? document.querySelector<HTMLElement>('.catalog-search-field input'))?.focus(), 60);
            }}
          />
        )}
      </label>

      <nav className="sidebar-nav" aria-label="Library navigation">
        {platform === 'apple' ? (
          <>
            {navRow('home', 'Listen Now', 'home')}
            {navRow('browse', 'Browse', 'browse')}
            {navRow('radio', 'Radio', 'radio')}
            {navRow('search', 'Search', 'search')}
            {navRow('library', 'Library', 'library')}
            <div className="sidebar-divider" aria-hidden="true" />
            {navRow('localfiles', 'Local Files', 'localfiles')}
            {navRow('sources', 'Sources', 'sources')}
            <button
              className="sidebar-nav-row sidebar-platform-switch"
              title={collapsed ? 'Back to local music' : undefined}
              onClick={() => {
                session.setPlatform('local');
                onNavigate('home');
              }}
            >
              <span className="sidebar-row-icon"><Glyph name="library" size={16} /></span>
              {!collapsed && <span className="sidebar-row-label">My Music</span>}
            </button>
          </>
        ) : (
          <>
            {navRow('home', 'Home', 'home')}
            {navRow('library', 'Library', 'library')}
            {navRow('sources', 'Sources', 'sources')}
            <div className="sidebar-divider" aria-hidden="true" />
            <button
              className="sidebar-nav-row sidebar-platform-switch"
              title={collapsed ? 'Apple Music' : undefined}
              onClick={() => {
                session.setPlatform('apple');
                onNavigate('home');
              }}
            >
              <span className="sidebar-row-icon"><Glyph name="apple" size={16} /></span>
              {!collapsed && <span className="sidebar-row-label">Apple Music</span>}
            </button>
          </>
        )}
      </nav>

      {needsAppleSignIn && !collapsed && (
        <button className="sidebar-signin" onClick={() => session.signInRoute('apple-musickit')}>
          Sign in to Apple Music
        </button>
      )}
      {needsAppleSignIn && collapsed && (
        <button className="sidebar-signin sidebar-signin-icon" aria-label="Sign in to Apple Music" title="Sign in to Apple Music" onClick={() => session.signInRoute('apple-musickit')}>
          <Glyph name="apple" size={16} />
        </button>
      )}
      {!collapsed && (
        <div className="sidebar-footer">
          <span className="sidebar-live-dot" />
          <span>{platform === 'apple' ? 'Apple Music' : 'Music, in one place'}</span>
        </div>
      )}
    </aside>
  );
}
