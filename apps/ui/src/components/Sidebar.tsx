import { useState, type ReactNode } from 'react';
import type { Location } from '../App';
import { session } from '../session';
import { useCollection } from '../collection';
import { AlbumsIcon, ArtistIcon, ChevronIcon, HomeIcon, SearchIcon, SongIcon, SourcesIcon, StarIcon } from '../icons';
import './shell.css';

interface SidebarProps {
  location: Location;
  collapsed: boolean;
  onNavigate(next: Location): void;
}

type SectionId = 'cadence' | 'library' | 'pins' | 'playlists';

/** Left navigation: search, collapsible sections, pins and playlists. */
export function Sidebar({ location, collapsed, onNavigate }: SidebarProps) {
  const pins = useCollection((s) => s.pins);
  const favoriteCount = useCollection((s) => s.favorites.length);
  const [closed, setClosed] = useState<Record<SectionId, boolean>>({ cadence: false, library: false, pins: false, playlists: false });

  const row = (key: string, label: string, icon: ReactNode, active: boolean, go: () => void, trailing?: ReactNode) => (
    <button
      key={key}
      className={`side-row ${active ? 'is-active' : ''}`}
      aria-current={active ? 'page' : undefined}
      title={label}
      aria-label={label}
      onClick={go}
    >
      <span className="side-row-icon">{icon}</span>
      <span className="side-row-label">{label}</span>
      {trailing}
    </button>
  );

  const section = (id: SectionId, title: string, children: ReactNode) => (
    <section className="side-section" aria-label={title}>
      <button
        className="side-section-head"
        aria-expanded={!closed[id]}
        onClick={() => setClosed((c) => ({ ...c, [id]: !c[id] }))}
      >
        <span>{title}</span>
        <span className={`side-chevron ${closed[id] ? 'is-closed' : ''}`}><ChevronIcon size={15} /></span>
      </button>
      {(!closed[id] || collapsed) && <div className="side-section-rows">{children}</div>}
    </section>
  );

  const isLib = (tab: string) => location.page === 'library' && location.tab === tab;
  const openSearch = (query: string) => {
    session.setLibraryQuery(query);
    onNavigate({ page: 'library', tab: 'songs' });
  };

  return (
    <aside className={`sidebar ${collapsed ? 'is-collapsed' : ''}`} aria-label="Sidebar">
      <div className="side-search">
        <button className="side-search-btn" aria-label="Search" title="Search" onClick={() => {
          openSearch('');
          setTimeout(() => document.querySelector<HTMLInputElement>('.lib-search input')?.focus(), 60);
        }}>
          <SearchIcon size={18} />
        </button>
        <label className="side-search-field">
          <input
            aria-label="Search your music"
            placeholder="Search"
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              openSearch(event.currentTarget.value.trim());
              event.currentTarget.value = '';
            }}
          />
          <SearchIcon size={16} />
        </label>
      </div>

      <nav className="side-scroll" aria-label="Main navigation">
        {section('cadence', 'Cadence', <>
          {row('home', 'Home', <HomeIcon size={19} />, location.page === 'home', () => onNavigate({ page: 'home' }))}
          {row('sources', 'Sources', <SourcesIcon size={19} />, location.page === 'sources', () => onNavigate({ page: 'sources' }))}
        </>)}
        {section('library', 'Library', <>
          {row('songs', 'Songs', <SongIcon size={19} />, isLib('songs'), () => onNavigate({ page: 'library', tab: 'songs' }))}
          {row('albums', 'Albums', <AlbumsIcon size={19} />, isLib('albums'), () => onNavigate({ page: 'library', tab: 'albums' }))}
          {row('artists', 'Artists', <ArtistIcon size={19} />, isLib('artists'), () => onNavigate({ page: 'library', tab: 'artists' }))}
        </>)}
        {pins.length > 0 && section('pins', 'Pins', pins.map((album) =>
          row(
            album.id,
            album.title,
            album.artwork ? <img className="side-thumb" src={album.artwork.url} alt="" /> : <AlbumsIcon size={19} />,
            location.page === 'album' && location.album.id === album.id,
            () => onNavigate({ page: 'album', album }),
          ),
        ))}
        {section('playlists', 'Playlists', <>
          {row(
            'favorites',
            'Favourite Songs',
            <StarIcon size={19} />,
            location.page === 'favorites',
            () => onNavigate({ page: 'favorites' }),
            favoriteCount > 0 && !collapsed ? <span className="side-count">{favoriteCount}</span> : undefined,
          )}
        </>)}
      </nav>
    </aside>
  );
}
