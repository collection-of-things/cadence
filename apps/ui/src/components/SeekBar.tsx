import { useEffect, useRef } from 'react';
import { session } from '../app';
import { formatTime } from '../format';
import { positionNow, useUi } from '../hooks';
import './controls.css';

/**
 * Seek bar with interpolated position. The fill, input value and elapsed label
 * are written by a rAF loop straight to the DOM — no per-frame React render.
 */
export function SeekBar() {
  const duration = useUi((s) => s.snapshot.durationMs);
  const route = useUi((s) => s.snapshot.lease?.route ?? s.snapshot.current?.track.route);
  const canSeek = useUi((s) => {
    const cap = s.capabilities.find((c) => c.route === route);
    return cap ? cap.playback.canSeek : true;
  });
  const disabled = !canSeek || duration <= 0;

  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
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
    <div className={`seek ${disabled ? 'seek-off' : ''}`}>
      <span className="seek-time" ref={timeRef}>
        0:00
      </span>
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
          }}
          onPointerUp={commit}
          onKeyUp={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') commit();
          }}
          onBlur={() => {
            scrubbing.current = false;
          }}
        />
      </div>
      <span className="seek-time seek-dur">{formatTime(duration)}</span>
    </div>
  );
}
