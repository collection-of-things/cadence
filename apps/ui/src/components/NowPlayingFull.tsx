import { useEffect, useRef } from 'react';
import { artistsLine } from '../format';
import { useUi } from '../hooks';
import { session } from '../app';
import { DownIcon, NoteIcon } from '../icons';
import { PixiBackground } from '../visuals/PixiBackground';
import { Lyrics } from './Lyrics';
import { SeekBar } from './SeekBar';
import { Transport } from './Transport';
import '../nowplaying-full.css';

export function NowPlayingFull({ onClose }: { onClose: () => void }) {
  const track = useUi((s) => s.snapshot.current?.track);
  const palette = useUi((s) => s.palette);
  const queueOpen = useUi((s) => s.queueOpen);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const touch = useRef<{ x: number; y: number; at: number } | null>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { onClose(); return; }
      if (event.key !== 'Tab') return;
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])');
      if (!controls?.length) return;
      const first = controls[0]!; const last = controls[controls.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
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
    <section ref={dialogRef} className="full-now" role="dialog" aria-modal="true" aria-label="Now playing" style={washVars}
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
        <div className="full-lyrics-card"><div className="full-lyrics-label">LYRICS <span>{track.lyrics && /\[\d+:\d{2}/.test(track.lyrics) ? 'SYNCED' : ''}</span></div><Lyrics raw={track.lyrics} /></div>
      </main>
      <div className="full-controls">
        <SeekBar />
        <Transport />
        <button className="full-queue icon-btn" aria-label="Show queue" aria-pressed={queueOpen} onClick={() => session.setQueueOpen(!queueOpen)}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 6h12M4 11h12M4 16h8" /><path d="m17.5 15 4 2.6-4 2.6z" fill="currentColor" stroke="none" /></svg>
        </button>
      </div>
    </section>
  );
}
