import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { artistsLine } from '../format';
import { useUi } from '../hooks';
import { session } from '../session';
import { CollapseIcon, LyricsIcon, NoteIcon, QueueIcon, SidebarIcon } from '../icons';
import { PixiBackground } from '../visuals/PixiBackground';
import { Lyrics } from './Lyrics';
import { providerForRoute, RouteBadge } from './RouteBadge';
import { SeekBar, TimeReadout } from './SeekBar';
import { Transport, VolumeControl } from './Transport';
import './lyrics.css';
import '../nowplaying-full.css';

const rgb = (c: readonly number[] | undefined, fallback: string) => (c ? `rgb(${c[0]} ${c[1]} ${c[2]})` : fallback);

/**
 * Immersive now playing: artwork bleeding into an artwork-coloured field,
 * a glass synced-lyrics card, and one floating control dock. Modal — the
 * browse app is inert while it is open.
 */
export function NowPlayingFull({ onClose }: { onClose: () => void }) {
  const track = useUi((s) => s.snapshot.current?.track);
  const palette = useUi((s) => s.palette);
  const queueOpen = useUi((s) => s.queueOpen);
  const [lyricsOn, setLyricsOn] = useState(true);
  const dialogRef = useRef<HTMLElement>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    // Inert the browse app so Tab can't leak behind the portal; the queue
    // and toasts are body children and stay live.
    const appEl = document.querySelector<HTMLElement>('.app');
    appEl?.setAttribute('inert', '');
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // An open queue owns Escape (it closes and restores focus itself).
        if (session.store.getState().queueOpen) return;
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const visible = (el: Element) => (el as HTMLElement).getClientRects().length > 0;
      const controls: HTMLElement[] = [];
      dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])')
        .forEach((el) => visible(el) && controls.push(el));
      document.querySelectorAll<HTMLElement>('.queue.open button:not(:disabled), .queue.open [tabindex]:not([tabindex="-1"]), .toasts button:not(:disabled)')
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

  if (!track) return null;
  const vars = {
    '--npf-c0': rgb(palette[0], 'rgb(120 40 50)'),
    '--npf-c1': rgb(palette[1], 'rgb(60 30 40)'),
    '--npf-c2': rgb(palette[2], 'rgb(30 30 40)'),
  } as CSSProperties;
  const art = track.artwork?.url;
  const showCard = lyricsOn && !queueOpen;
  const sub = [track.album, artistsLine(track.artists)].filter(Boolean).join(' – ');

  return (
    <section
      ref={dialogRef}
      tabIndex={-1}
      className={`npf ${showCard ? 'has-card' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Now playing: ${track.title}`}
      style={vars}
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
      <div className="npf-field" aria-hidden="true">
        <PixiBackground palette={palette} />
        {art && <img className="npf-blur" src={art} alt="" />}
        <div className="npf-tint" />
      </div>
      <div className="npf-art" aria-hidden={!art}>
        {art ? <img key={track.id} src={art} alt={`${track.album ?? track.title} artwork`} draggable={false} /> : <NoteIcon size={96} />}
      </div>

      <div className="npf-corner chrome-pill">
        <button className="chrome-btn" aria-label="Back to library" title="Back to library" onClick={onClose}>
          <SidebarIcon size={19} />
        </button>
        <button
          className={`chrome-btn ${showCard ? 'is-on' : ''}`}
          aria-label="Lyrics"
          aria-pressed={showCard}
          title="Lyrics"
          onClick={() => {
            if (queueOpen) session.setQueueOpen(false);
            setLyricsOn(!showCard);
          }}
        >
          <LyricsIcon size={19} />
        </button>
      </div>

      {showCard && (
        <div className="npf-card">
          <Lyrics key={track.id} raw={track.lyrics} />
        </div>
      )}

      <div className="npf-dock" role="group" aria-label="Playback controls">
        <Transport />
        <TimeReadout />
        <div className="npf-track">
          <div className="npf-track-text">
            <span className="npf-track-title" title={track.title}>{track.title}</span>
            <span className="npf-track-sub" title={sub}>{sub}</span>
          </div>
          <RouteBadge provider={providerForRoute(track.route)} title={`Route: ${track.route}`} />
          <SeekBar variant="line" />
        </div>
        <VolumeControl slider={false} />
        <button className={`ctl-btn ${queueOpen ? 'is-on' : ''}`} aria-label="Queue" aria-pressed={queueOpen} title="Queue" data-queue-toggle onClick={() => session.setQueueOpen(!queueOpen)}>
          <QueueIcon size={19} />
        </button>
        <button
          className={`ctl-btn ${showCard ? 'is-on' : ''}`}
          aria-label="Show lyrics"
          aria-pressed={showCard}
          title="Lyrics"
          onClick={() => {
            if (queueOpen) session.setQueueOpen(false);
            setLyricsOn(!showCard);
          }}
        >
          <LyricsIcon size={19} />
        </button>
        <button className="ctl-btn" aria-label="Exit full screen" title="Exit full screen (Esc)" onClick={onClose}>
          <CollapseIcon size={18} />
        </button>
      </div>
    </section>
  );
}
