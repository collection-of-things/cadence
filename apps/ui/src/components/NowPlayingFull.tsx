import { useEffect, useRef, useState } from 'react';
import { useUi } from '../hooks';
import { prefs } from '../prefs';
import { session } from '../session';
import { withoutMotion } from '../instant';
import { useEscapeLayer } from '../layers';
import type { Location } from '../navigation';
import { ChevronIcon, NoteIcon, SidebarIcon } from '../icons';
import { Lyrics } from './Lyrics';
import { PlayerBar, useSwapClass } from './PlayerBar';
import { QueuePanel } from './QueuePanel';
import { Sidebar } from './Sidebar';
import './lyrics.css';
import '../nowplaying-full.css';

/**
 * Now Playing: the artwork fills the left and melts into the ambient
 * colour field, synced lyrics float on the right with no card around them,
 * and the player dock sits below. Turning lyrics off centres the artwork.
 * Modal — the browse app is inert while it is open.
 */
interface NowPlayingFullProps {
  onClose(): void;
  /** The shell's location and navigation, for the sidebar shown over Now Playing. */
  location: Location;
  onNavigate(next: Location): void;
  /** Whether the shell's side panel is open, which sets where the docked player sat. */
  panelShown: boolean;
}

export function NowPlayingFull({ onClose, location, onNavigate, panelShown }: NowPlayingFullProps) {
  // Read once: the player keeps the docked bar's position while the queue toggles in here.
  const [panelAtOpen] = useState(panelShown);
  const track = useUi((s) => s.snapshot.current?.track);
  const paused = useUi((s) => s.snapshot.status !== 'playing');
  const [lyricsOn, setLyricsOn] = useState(() => prefs.getState().lyricsInNowPlaying);
  // The corner button slides the sidebar in over Now Playing; picking a page
  // there leaves Now Playing for it.
  const [navOpen, setNavOpen] = useState(false);
  const queueOpen = useUi((s) => s.queueOpen);
  // The right column: Up Next while the queue is open, else lyrics (or nothing).
  const column = queueOpen ? 'queue' : lyricsOn ? 'lyrics' : null;
  const toggleLyrics = () => {
    if (queueOpen) {
      session.setQueueOpen(false);
      setLyricsOn(true);
    } else setLyricsOn((on) => !on);
  };
  const dialogRef = useRef<HTMLElement>(null);
  // Track changes animate; opening Now Playing has its own entrance.
  const swap = useSwapClass(track?.id);
  const touch = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    // Inert the browse app so Tab stays in the dialog, including its queue.
    // Toast buttons live outside the dialog and stay reachable.
    const appEl = document.querySelector<HTMLElement>('.app');
    appEl?.setAttribute('inert', '');
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const visible = (el: Element) => (el as HTMLElement).getClientRects().length > 0;
      const controls: HTMLElement[] = [];
      dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])')
        .forEach((el) => visible(el) && controls.push(el));
      document.querySelectorAll<HTMLElement>('.toasts button:not(:disabled)')
        .forEach((el) => visible(el) && controls.push(el));
      if (!controls.length) return;
      const idx = controls.indexOf(document.activeElement as HTMLElement);
      const step = event.shiftKey ? -1 : 1;
      event.preventDefault();
      controls[(((idx + step) % controls.length) + controls.length) % controls.length]?.focus();
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      appEl?.removeAttribute('inert');
      // Restore focus, but never onto a button that would steal Space.
      if (previous?.isConnected && previous !== document.body) previous.focus();
      else (document.activeElement as HTMLElement | null)?.blur?.();
    };
  }, [onClose]);

  // An open queue ranks above Now Playing, so Escape closes that first.
  useEscapeLayer('nowPlaying', true, () => withoutMotion(onClose));

  if (!track) return null;
  const art = track.artwork?.url;

  return (
    <section
      ref={dialogRef}
      tabIndex={-1}
      className={`npf ${column ? 'has-lyrics' : ''} ${navOpen ? 'has-nav' : ''} ${paused ? 'is-paused' : ''} ${panelAtOpen ? 'has-rail' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Now playing: ${track.title}`}
      onTouchStart={(e) => {
        const t = e.touches[0];
        if (e.touches.length === 1 && t) touch.current = { x: t.clientX, y: t.clientY };
      }}
      onTouchEnd={(e) => {
        const start = touch.current;
        const end = e.changedTouches[0];
        touch.current = null;
        if (!start || !end) return;
        const dy = end.clientY - start.y;
        if (dy > 80 && dy > Math.abs(end.clientX - start.x) * 1.5 && !(e.target as HTMLElement).closest('.lyrics-scroll, .lyrics-plain')) onClose();
      }}
    >
      {/* The dock leads DOM order so its transport is the first play-named
          control in the dialog; it is positioned, so layout is unaffected. */}
      <PlayerBar placement="floating" lyricsOn={column === 'lyrics'} onToggleLyrics={toggleLyrics} onToggleFullScreen={onClose} onOpenPhoneSettings={() => { onClose(); onNavigate({ page: 'settings', section: 'phone' }); }} />

      <div className="npf-art" aria-hidden={!art}>
        {art ? <img key={track.id} className={swap} src={art} alt={`${track.album ?? track.title} artwork`} draggable={false} /> : <NoteIcon size={96} />}
      </div>

      <div className="npf-corner">
        <button
          className={`chrome-btn ${navOpen ? 'is-on' : ''}`}
          aria-label="Sidebar"
          aria-pressed={navOpen}
          title={navOpen ? 'Hide sidebar' : 'Show sidebar'}
          onClick={() => setNavOpen((open) => !open)}
        >
          <SidebarIcon size={18} />
        </button>
        <button className="chrome-btn" aria-label="Back" title="Back" onClick={onClose}>
          <ChevronIcon dir="left" size={18} />
        </button>
      </div>

      {navOpen && (
        <div className="npf-nav">
          <Sidebar
            location={location}
            onNavigate={(next) => {
              onNavigate(next);
              onClose();
            }}
          />
        </div>
      )}

      {column === 'lyrics' && (
        <div className="npf-lyrics">
          <Lyrics key={track.id} track={track} />
        </div>
      )}
      {column === 'queue' && (
        <div className="npf-lyrics npf-queue">
          <h2 className="npf-col-title">Up Next</h2>
          <QueuePanel />
        </div>
      )}
    </section>
  );
}
