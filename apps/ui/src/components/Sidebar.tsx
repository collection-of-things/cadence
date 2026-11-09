import { useState, type CSSProperties, type ReactNode } from 'react';
import type { CatalogContainer, CatalogRequest, PlatformId } from '@cadence/protocol';
import type { Location } from '../App';
import { session } from '../session';
import { useCollection } from '../collection';
import { useUi } from '../hooks';
import {
  AlbumsIcon,
  AppleIcon,
  ArtistIcon,
  BrowseIcon,
  ChevronIcon,
  FolderIcon,
  HomeIcon,
  RadioIcon,
  SongIcon,
  SourcesIcon,
  StarIcon,
} from '../icons';
import { useCatalogPage } from './provider/catalog';
import './shell.css';

interface SidebarProps {
  location: Location;
  onNavigate(next: Location): void;
}

type SectionId = 'music' | 'library' | 'pins' | 'playlists';

const LIBRARY_PLAYLISTS: CatalogRequest = { kind: 'library', collection: 'playlists', limit: 50 };

/** The signed-in Apple Music library's playlists, for the sidebar. Empty until ready. */
function useApplePlaylists(enabled: boolean): CatalogContainer[] {
  const { page } = useCatalogPage(enabled ? 'apple-musickit' : null, enabled ? LIBRARY_PLAYLISTS : null);
  return page?.sections.flatMap((s) => s.entries).flatMap((e) => (e.kind === 'playlist' ? [e.playlist] : [])) ?? [];
}

/** Platforms the switcher offers, in display order. */
const PLATFORMS = [
  { id: 'apple', label: 'Apple', name: 'Apple Music', tile: 'svc-apple', icon: <AppleIcon size={12} /> },
  { id: 'local', label: 'Local', name: 'Local files', tile: 'svc-local', icon: <FolderIcon size={12} /> },
] as const satisfies readonly { id: PlatformId; label: string; name: string; tile: string; icon: ReactNode }[];

/**
 * The sidebar attached to the window's left edge: brand, platform switcher, then the active
 * platform's navigation, pins and playlists.
 */
export function Sidebar({ location, onNavigate }: SidebarProps) {
  const pins = useCollection((s) => s.pins);
  const favoriteCount = useCollection((s) => s.favorites.length);
  const platform = useUi((s) => s.platform);
  const capabilities = useUi((s) => s.capabilities);
  const [closed, setClosed] = useState<Record<SectionId, boolean>>({ music: false, library: false, pins: false, playlists: false });
  const isApple = platform === 'apple';
  const appleCap = capabilities.find((c) => c.route === 'apple-musickit');
  const appleSignedOut = appleCap !== undefined && appleCap.state !== 'ready';
  const applePlaylists = useApplePlaylists(isApple && appleCap?.state === 'ready');
  const switchIndex = Math.max(0, PLATFORMS.findIndex((p) => p.id === platform));

  const row = (key: string, label: string, icon: ReactNode, active: boolean, go: () => void, trailing?: ReactNode, extra = '') => (
    <button
      key={key}
      className={`side-row ${extra} ${active ? 'is-active' : ''}`}
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
        <span className={`side-chevron ${closed[id] ? 'is-closed' : ''}`}><ChevronIcon size={13} /></span>
      </button>
      {!closed[id] && <div className="side-section-rows">{children}</div>}
    </section>
  );

  const isLib = (tab: string) => location.page === 'library' && location.tab === tab;

  const switchPlatform = (next: PlatformId) => {
    if (next === platform) return;
    session.setPlatform(next);
    onNavigate({ page: 'home' });
  };

  return (
    <aside className="sidebar" aria-label="Sidebar">
      <div className="side-top">
        <div className="side-brand" aria-label="Cadence">
          <img src={`${import.meta.env.BASE_URL}brand/mark.svg`} width="24" height="24" alt="" />
          <span className="side-brand-name">Cadence</span>
        </div>
        <div className="side-switch" role="radiogroup" aria-label="Music service" style={{ '--n': PLATFORMS.length, '--i': switchIndex } as CSSProperties}>
          <span className="side-switch-ind" aria-hidden="true" />
          {PLATFORMS.map((p) => {
            const pending = p.id === 'apple' && appleSignedOut;
            return (
              <button
                key={p.id}
                role="radio"
                aria-checked={platform === p.id}
                className={platform === p.id ? 'is-on' : ''}
                aria-label={p.name}
                title={pending ? `${p.name}, not signed in` : p.name}
                onClick={() => switchPlatform(p.id)}
              >
                <span className={`svc-tile ${p.tile}`} aria-hidden="true">
                  {p.icon}
                  {pending && <span className="svc-pending">+</span>}
                </span>
                <span className="side-switch-label">{p.label}</span>
              </button>
            );
          })}
        </div>
        {isApple && row('localfiles', 'Local Files', <FolderIcon size={17} />, location.page === 'localfiles',
          () => onNavigate({ page: 'localfiles', tab: 'albums' }), undefined, 'side-local')}
      </div>

      <nav className="side-scroll platform-fade" key={platform} aria-label="Main navigation">
        {section('music', 'Music', isApple ? (
          <>
            {row('home', 'Listen Now', <HomeIcon size={17} />, location.page === 'home', () => onNavigate({ page: 'home' }))}
            {row('browse', 'Browse', <BrowseIcon size={17} />, location.page === 'browse', () => onNavigate({ page: 'browse' }))}
            {row('radio', 'Radio', <RadioIcon size={17} />, location.page === 'radio', () => onNavigate({ page: 'radio' }))}
          </>
        ) : (
          <>
            {row('home', 'Home', <HomeIcon size={17} />, location.page === 'home', () => onNavigate({ page: 'home' }))}
            {row('sources', 'Sources', <SourcesIcon size={17} />, location.page === 'sources', () => onNavigate({ page: 'sources' }))}
          </>
        ))}
        {section('library', 'Library', isApple ? (
          <>
            {row('library', 'Apple Library', <AlbumsIcon size={17} />, location.page === 'library', () => onNavigate({ page: 'library', tab: 'albums' }))}
            {row('sources', 'Sources', <SourcesIcon size={17} />, location.page === 'sources', () => onNavigate({ page: 'sources' }))}
          </>
        ) : (
          <>
            {row('songs', 'Songs', <SongIcon size={17} />, isLib('songs'), () => onNavigate({ page: 'library', tab: 'songs' }))}
            {row('albums', 'Albums', <AlbumsIcon size={17} />, isLib('albums'), () => onNavigate({ page: 'library', tab: 'albums' }))}
            {row('artists', 'Artists', <ArtistIcon size={17} />, isLib('artists'), () => onNavigate({ page: 'library', tab: 'artists' }))}
          </>
        ))}
        {pins.length > 0 && section('pins', 'Pins', pins.map((album) =>
          row(
            album.id,
            album.title,
            album.artwork ? <img className="side-thumb" src={album.artwork.url} alt="" /> : <AlbumsIcon size={17} />,
            location.page === 'album' && location.album.id === album.id,
            () => onNavigate({ page: 'album', album }),
          ),
        ))}
        {section('playlists', 'Playlists', <>
          {row(
            'favorites',
            'Favourite Songs',
            <StarIcon size={17} />,
            location.page === 'favorites',
            () => onNavigate({ page: 'favorites' }),
            favoriteCount > 0 ? <span className="side-count">{favoriteCount}</span> : undefined,
          )}
          {applePlaylists.map((playlist) =>
            row(
              `playlist:${playlist.id}`,
              playlist.title,
              playlist.artwork ? <img className="side-thumb" src={playlist.artwork.url} alt="" loading="lazy" /> : <AlbumsIcon size={17} />,
              location.page === 'detail' && location.container.id === playlist.id,
              () => onNavigate({ page: 'detail', container: playlist }),
            ),
          )}
        </>)}
      </nav>

      {isApple && appleSignedOut && (
        <div className="side-foot">
          <button className="sidebar-signin" aria-label="Sign in to Apple Music" title="Sign in to Apple Music" onClick={() => session.signInRoute('apple-musickit')}>
            <AppleIcon size={15} />
            <span>Sign in to Apple Music</span>
          </button>
        </div>
      )}
    </aside>
  );
}
