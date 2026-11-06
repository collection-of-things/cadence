import { useEffect, useRef, useState } from 'react';
import type { TrackRef } from '@cadence/protocol';
import { artistsLine } from '../format';
import { useUi } from '../hooks';
import { api, session } from '../app';
import { DownIcon, MuteIcon, NoteIcon, VolumeIcon } from '../icons';
import { PixiBackground } from '../visuals/PixiBackground';
import { Lyrics } from './Lyrics';
import { SeekBar } from './SeekBar';
import { Transport } from './Transport';
import '../nowplaying-full.css';

/** Provider tracks carry no lyrics on the TrackRef — fetch on demand. */
function useTrackLyrics(track: TrackRef | undefined): string | undefined {
  const [lyrics, setLyrics] = useState<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setLyrics(undefined);
    if (!track || track.lyrics || !api.catalog) return;
    if (track.source.kind !== 'provider' || !track.source.providerItemId) return;
    const id = track.source.providerItemId;
    api.catalog
      .query(track.route, { kind: 'lyrics', songId: id })
      .then((page) => {
        if (live && page.lyrics) setLyrics(page.lyrics);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [track]);
  return track?.lyrics ?? lyrics;
}

export function NowPlayingFull({ onClose }: { onClose: () => void }) {
  const track = useUi((s) => s.snapshot.current?.track);
  const trackLyrics = useTrackLyrics(track);
  const palette = useUi((s) => s.palette);
  const queueOpen = useUi((s) => s.queueOpen);
  const muted = useUi((s) => s.snapshot.muted === true);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const touch = useRef<{ x: number; y: number; at: number } | null>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    // inert the browse app so Tab can't leak into page-order DOM behind
    // the portal; the queue and toasts are body children and stay live.
    const appEl = document.querySelector<HTMLElement>('.app');
    appEl?.setAttribute('inert', '');
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (session.store.getState().queueOpen) { event.stopImmediatePropagation?.(); session.setQueueOpen(false); return; }
        onClose(); return;
      }
      if (event.key !== 'Tab') return;
      const visible = (el: Element) => (el as HTMLElement).getClientRects().length > 0;
      const dialog = dialogRef.current;
      const controls: HTMLElement[] = [];
      if (dialog) {
        dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])')
          .forEach((el) => { if (visible(el)) controls.push(el); });
      }
      document.querySelectorAll<HTMLElement>('.queue.open button:not(:disabled), .queue.open [tabindex]:not([tabindex="-1"]), .toasts button:not(:disabled)')
        .forEach((el) => { if (visible(el)) controls.push(el); });
      if (!controls.length) return;
      const active = document.activeElement as HTMLElement | null;
      const idx = active ? controls.indexOf(active) : -1;
      const step = event.shiftKey ? -1 : 1;
      event.preventDefault();
      controls[(((idx + step) % controls.length) + controls.length) % controls.length]?.focus();
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      appEl?.removeAttribute('inert');
      // Back to whatever was focused when we opened; if that was the page
      // (body), stay there — a focused button would steal Space from playback.
      if (previous?.isConnected && previous !== document.body) previous.focus();
      else (document.activeElement as HTMLElement | null)?.blur?.();
    };
  }, [onClose]);

  if (!track) return null;
  // Artwork-coloured wash as a real fallback when WebGL is unavailable —
  // and a base layer while the shader warms up.
  const css = (c: [number, number, number] | undefined, fallback: string) =>
    c ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : fallback;
  const washVars = {
    '--npf-c0': css(palette?.[0], 'rgb(110,60,140)'),
    '--npf-c1': css(palette?.[1], 'rgb(150,80,50)'),
    '--npf-c2': css(palette?.[2], 'rgb(40,40,70)'),
  } as React.CSSProperties;
  return (
    <section ref={dialogRef} tabIndex={-1} className={`full-now ${queueOpen ? "has-queue" : ""}`} role="dialog" aria-modal="true" aria-label="Now playing" style={washVars}
      onTouchStart={(e) => { if (e.touches.length === 1) touch.current = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY, at: Date.now() }; }}
      onTouchEnd={(e) => {
        const start = touch.current; touch.current = null;
        if (!start || !e.changedTouches[0]) return;
        const dy = e.changedTouches[0].clientY - start.y;
        const dx = Math.abs(e.changedTouches[0].clientX - start.x);
        if (dy > 80 && dy > dx * 1.5 && (e.target as HTMLElement).closest('.full-lyrics-scroll, .full-lyrics-plain') == null) onClose();
      }}>
      <PixiBackground palette={palette} />
      <div className="full-wash" />
      <header className="full-header">
        <button ref={closeRef} className="full-close" onClick={onClose} aria-label="Close full screen now playing"><DownIcon size={24} /></button>
        <span>NOW PLAYING</span><span className="full-brand">CADENCE</span>
      </header>
      <main className="full-content">
        <div className="full-record">
          <div className="full-art">{track.artwork ? <img src={track.artwork.url} alt={`${track.album ?? track.title} artwork`} draggable={false} /> : <NoteIcon size={72} />}</div>
          <div className="full-meta"><h1>{track.title}</h1><p>{artistsLine(track.artists)}{track.album && <><span> · </span>{track.album}</>}</p></div>
        </div>
        <div className="full-lyrics-card"><div className="full-lyrics-label">LYRICS <span>{trackLyrics && /\[\d+:\d{2}/.test(trackLyrics) ? 'SYNCED' : ''}</span></div><Lyrics raw={trackLyrics} /></div>
      </main>
      <div className="full-controls">
        <SeekBar />
        <div className="full-dock">
          <Transport />
          <button className="full-mute icon-btn" aria-label={muted ? 'Unmute' : 'Mute'} onClick={() => session.toggleMute()}>
            {muted ? <MuteIcon size={17} /> : <VolumeIcon size={17} />}
          </button>
          <button className="full-queue icon-btn" aria-label="Show queue" aria-pressed={queueOpen} onClick={() => session.setQueueOpen(!queueOpen)}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 6h12M4 11h12M4 16h8" /><path d="m17.5 15 4 2.6-4 2.6z" fill="currentColor" stroke="none" /></svg>
          </button>
        </div>
      </div>
    </section>
  );
}
