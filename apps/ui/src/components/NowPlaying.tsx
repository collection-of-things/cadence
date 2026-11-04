import { useEffect, useRef } from 'react';
import { session } from '../app';
import { artistsLine } from '../format';
import { useReducedMotion, useUi } from '../hooks';
import { NoteIcon } from '../icons';
import { PixiBackground } from '../visuals/PixiBackground';
import { CapabilityChips } from './CapabilityChips';
import { providerForRoute, RouteBadge } from './RouteBadge';
import { SeekBar } from './SeekBar';
import { Transport } from './Transport';

function Artwork() {
  const track = useUi((s) => s.snapshot.current?.track);
  const status = useUi((s) => s.snapshot.status);
  const palette = useUi((s) => s.palette);
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);

  // Subtle scale/shadow breathing driven by FFT energy, outside React state.
  useEffect(() => {
    if (reduced) return;
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const { fft, clock } = session.runtime;
      const live = Date.now() - fft.atMs < 500 && clock.playing;
      const target = live ? 1 + fft.peak * 0.015 : 1;
      const cur = parseFloat(el.dataset.s ?? '1');
      const next = cur + (target - cur) * 0.08;
      el.dataset.s = String(next);
      el.style.transform = `scale(${next.toFixed(4)})`;
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      el.style.transform = '';
    };
  }, [reduced]);

  if (!track) return null;
  const glow = palette[0];
  return (
    <div
      className={`np-art ${status === 'playing' ? 'live' : ''}`}
      ref={ref}
      style={glow ? { boxShadow: `0 24px 90px -18px rgba(${glow[0]},${glow[1]},${glow[2]},0.45), 0 12px 40px rgba(0,0,0,0.55)` } : undefined}
    >
      {track.artwork ? (
        <img key={track.id} src={track.artwork.url} alt={`${track.album ?? track.title} artwork`} draggable={false} />
      ) : (
        <div className="np-art-empty">
          <NoteIcon size={64} />
        </div>
      )}
    </div>
  );
}

export function NowPlaying() {
  // Narrow selectors: position/fft updates at 2-20Hz must not re-render this
  // tree — the seek bar and Pixi layer read those off-store.
  const status = useUi((s) => s.snapshot.status);
  const lastError = useUi((s) => s.snapshot.lastError);
  const palette = useUi((s) => s.palette);
  const track = useUi((s) => s.snapshot.current?.track);

  return (
    <div className="np">
      <PixiBackground palette={palette} />
      {track ? (
        <div className="np-inner">
          <Artwork />
          <div className="np-meta">
            <RouteBadge provider={providerForRoute(track.route)} title={`Route: ${track.route}`} />
            <h1 className="np-title" title={track.title}>
              {track.title}
            </h1>
            <div className="np-sub">
              <span className="np-artist">{artistsLine(track.artists)}</span>
              {track.album && (
                <>
                  <span className="np-dot">·</span>
                  <span className="np-album" title={track.album}>
                    {track.album}
                  </span>
                </>
              )}
              {track.year && (
                <>
                  <span className="np-dot">·</span>
                  <span>{track.year}</span>
                </>
              )}
            </div>
            {status === 'error' && lastError && (
              <div className="np-error" role="alert">
                {lastError.message}
              </div>
            )}
            <CapabilityChips />
            <SeekBar />
            <Transport />
          </div>
        </div>
      ) : (
        <div className="np-empty">
          <NoteIcon size={72} />
          <h1>Nothing playing</h1>
          <p>Pick an album or a track from your library.</p>
          <button className="btn" onClick={() => session.setView('library')}>
            Open Library
          </button>
        </div>
      )}
    </div>
  );
}
