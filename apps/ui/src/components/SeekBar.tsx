import { useEffect, useRef } from 'react';
import { session } from '../session';
import { formatTime } from '../format';
import { positionNow, useUi } from '../hooks';
import './controls.css';

function useCanSeek(): { duration: number; disabled: boolean } {
  const duration = useUi((s) => s.snapshot.durationMs);
  const canSeek = useUi((s) => {
    const route = s.snapshot.lease?.route ?? s.snapshot.current?.track.route;
    const cap = s.capabilities.find((c) => c.route === route);
    return cap ? cap.playback.canSeek : true;
  });
  return { duration, disabled: !canSeek || duration <= 0 };
}

/**
 * Seek bar with interpolated position. The fill, input value and time labels
 * are written by a rAF loop straight to the DOM — no per-frame React render.
 * `bar` shows elapsed and remaining time beside the track; `line` is the
 * bare track used inside the full-screen dock.
 */
export function SeekBar({ variant = 'bar' }: { variant?: 'bar' | 'line' }) {
  const { duration, disabled } = useCanSeek();
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const leftRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const input = inputRef.current;
      const wrap = wrapRef.current;
      if (!input || !wrap || scrubbing.current) return;
      const pos = positionNow();
      if (document.activeElement !== input) input.value = String(Math.round(pos));
      wrap.style.setProperty('--p', String(duration > 0 ? Math.min(1, pos / duration) : 0));
      if (timeRef.current) timeRef.current.textContent = formatTime(pos);
      if (leftRef.current) leftRef.current.textContent = `-${formatTime(Math.max(0, duration - pos))}`;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [duration]);

  const commit = () => {
    const input = inputRef.current;
    if (input) session.seek(Number(input.value));
    scrubbing.current = false;
  };

  return (
    <div className={`seek seek-${variant} ${disabled ? 'seek-off' : ''}`}>
      {variant === 'bar' && <span className="seek-time" ref={timeRef}>0:00</span>}
      <div
        className="seek-track"
        ref={wrapRef}
        onMouseMove={(e) => {
          const tip = tipRef.current;
          const wrap = wrapRef.current;
          if (!tip || !wrap || duration <= 0) return;
          const r = wrap.getBoundingClientRect();
          const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
          tip.style.left = `${ratio * 100}%`;
          tip.textContent = formatTime(ratio * duration);
          tip.classList.add('on');
        }}
        onMouseLeave={() => tipRef.current?.classList.remove('on')}
      >
        <div className="seek-tip" ref={tipRef} />
        <input
          ref={inputRef}
          type="range"
          className="seek-input"
          aria-label="Seek"
          min={0}
          max={Math.max(1, Math.round(duration))}
          step={250}
          defaultValue={0}
          disabled={disabled}
          onChange={(e) => {
            const wrap = wrapRef.current;
            const v = Number(e.currentTarget.value);
            scrubbing.current = true;
            if (wrap) wrap.style.setProperty('--p', String(duration > 0 ? v / duration : 0));
            if (timeRef.current) timeRef.current.textContent = formatTime(v);
            if (leftRef.current) leftRef.current.textContent = `-${formatTime(Math.max(0, duration - v))}`;
          }}
          onPointerUp={commit}
          onKeyDown={(e) => {
            // Drive seeks off the live position — the focused input's own
            // value goes stale while the rAF writer holds back.
            const delta = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 5000
              : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -5000
              : e.key === 'Home' ? -Infinity : e.key === 'End' ? Infinity : 0;
            if (!delta) return;
            e.preventDefault();
            session.seek(Math.max(0, Math.min(duration, positionNow() + delta)));
          }}
          onBlur={() => {
            scrubbing.current = false;
          }}
        />
      </div>
      {variant === 'bar' && <span className="seek-time seek-left" ref={leftRef}>-0:00</span>}
    </div>
  );
}

/** "elapsed / -remaining" text, rAF-written like the seek bar. */
export function TimeReadout() {
  const duration = useUi((s) => s.snapshot.durationMs);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    let last = '';
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const pos = positionNow();
      const text = `${formatTime(pos)} / -${formatTime(Math.max(0, duration - pos))}`;
      if (text !== last && ref.current) ref.current.textContent = last = text;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [duration]);
  return <span className="time-readout" ref={ref} aria-hidden="true" />;
}
