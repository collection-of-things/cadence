import { session } from '../app';
import { useEffect, useState } from 'react';
import { SearchIcon } from '../icons';
import './shell.css';

export type ShellPage = 'home' | 'library' | 'sources' | 'now' | 'album' | 'playlist';

type NavSection = 'home' | 'library' | 'sources' | 'playlists';

function Glyph({ name, size = 17 }: { name: NavSection; size?: number }) {
  const common = { stroke: 'currentColor', strokeWidth: 1.65, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {name === 'home' && <><path d="m3.6 10.5 8.4-7 8.4 7" {...common} /><path d="M5.8 9.3v10.2h12.4V9.3M9.4 19.5v-6h5.2v6" {...common} /></>}
      {name === 'library' && <><path d="M4 5.2h16M4 9.8h16M4 14.4h10" {...common} /><path d="M4 19h8" {...common} /><circle cx="18" cy="17.6" r="2.8" {...common} /></>}
      {name === 'sources' && <><path d="M5 8.2h14a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7.6a2 2 0 0 1 2-2Z" {...common} /><path d="M8 8.2V6.6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v1.6M12 12v4" {...common} /></>}
      {name === 'playlists' && <><path d="M5 5.5h13M5 10h13M5 14.5h8" {...common} /><path d="M17 14.2v5.2m0 0 3-1.7" {...common} /></>}
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`sidebar-chevron ${open ? 'is-open' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m8 10 4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface SidebarProps {
  activePage: ShellPage;
  collapsed: boolean;
  onNavigate(page: Exclude<ShellPage, 'album'>): void;
}

export function Sidebar({ activePage, collapsed, onNavigate }: SidebarProps) {
  const [open, setOpen] = useState<Record<NavSection, boolean>>({ home: true, library: true, sources: true, playlists: true });
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 690px)').matches);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 690px)');
    const update = () => setCompact(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const toggleSection = (section: NavSection, target: Exclude<ShellPage, 'album'> | null) => {
    if (collapsed || compact) {
      if (target !== null) onNavigate(target);
      return;
    }
    setOpen((state) => ({ ...state, [section]: !state[section] }));
  };

  const section = (name: NavSection, label: string, target: Exclude<ShellPage, 'album'> | null, childLabel: string, disabled = false) => {
    const isActive = target !== null && activePage === target;
    const expanded = open[name];
    return (
      <section className={`sidebar-section ${isActive ? 'has-active' : ''}`} key={name}>
        <button
          className="sidebar-section-head"
          aria-expanded={collapsed ? undefined : expanded}
          aria-label={collapsed ? label : undefined}
          title={collapsed ? label : undefined}
          onClick={() => toggleSection(name, target)}
        >
          <span className="sidebar-section-icon"><Glyph name={name} /></span>
          <span className="sidebar-section-label">{label}</span>
          <Chevron open={expanded} />
        </button>
        {!collapsed && expanded && (
          <button
            className={`sidebar-nav-row ${isActive ? 'is-active' : ''} ${disabled ? 'is-disabled' : ''}`}
            aria-current={isActive ? 'page' : undefined}
            disabled={disabled}
            onClick={() => !disabled && target !== null && onNavigate(target)}
          >
            <span className="sidebar-row-icon"><Glyph name={name} size={15} /></span>
            <span className="sidebar-row-label">{childLabel}</span>
            {disabled && <span className="sidebar-coming">Soon</span>}
          </button>
        )}
      </section>
    );
  };

  return (
    <aside className={`sidebar ${collapsed ? 'is-collapsed' : ''}`} aria-label="Main sidebar">
      <div className="sidebar-brand">
        <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
        {!collapsed && <span className="sidebar-brand-name">cadence</span>}
      </div>

      <label className="sidebar-search">
        <SearchIcon size={16} />
        {!collapsed && <input aria-label="Search Cadence" placeholder="Search your music" onKeyDown={(event) => {
          if (event.key === 'Enter') {
            session.setLibraryQuery(event.currentTarget.value.trim());
            onNavigate('library');
          }
        }} />}
        {collapsed && <span className="sidebar-search-tooltip">Search</span>}
        {(collapsed || compact) && <span className="sidebar-compact-search-hit" onClick={() => onNavigate('library')} />}
      </label>

      <nav className="sidebar-nav" aria-label="Library navigation">
        {section('home', 'Home', 'home', 'For you')}
        {section('library', 'Library', 'library', 'Albums & tracks')}
        {section('sources', 'Sources', 'sources', 'Connected services')}
        {section('playlists', 'Playlists', 'playlist', 'All playlists')}
      </nav>

      {!collapsed && (
        <div className="sidebar-footer">
          <span className="sidebar-live-dot" />
          <span>Music, in one place</span>
        </div>
      )}
    </aside>
  );
}
