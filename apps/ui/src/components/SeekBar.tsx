import { useEffect, useRef } from 'react';
import { session } from '../session';
import { formatTime } from '../format';
import { positionNow, useUi } from '../hooks';
import { activeCapabilities } from '../routes';
import './controls.css';

function useCanSeek(): { duration: number; disabled: boolean } {
  const duration = useUi((s) => s.snapshot.durationMs);
  const canSeek = useUi((s) => activeCapabilities(s)?.playback.canSeek ?? true);
  return { duration, disabled: !canSeek || duration <= 0 };
}

/**
 * Bare seek line with interpolated position, used on the player's track box.
 * The fill and input value are written by a rAF loop straight to the DOM, so
 * there is no per-frame React render.
 */
export function SeekBar() {
  const { duration, disabled } = useCanSeek();
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
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
      input.value = String(Math.round(pos));
      wrap.style.setProperty('--p', String(duration > 0 ? Math.min(1, pos / duration) : 0));
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
    <div className={`seek seek-line ${disabled ? 'seek-off' : ''}`}>
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
        <span className="seek-knob" aria-hidden="true" />
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
          }}
          onPointerUp={commit}
          onPointerCancel={() => { scrubbing.current = false; }}
          onKeyDown={(e) => {
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
    </div>
  );
}

/** One time label either side of the seek bar, rAF-written like the bar itself. */
export function TimeReadout({ part }: { part: 'elapsed' | 'remaining' }) {
  const duration = useUi((s) => s.snapshot.durationMs);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    let last = '';
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const pos = positionNow();
      const text = part === 'elapsed' ? formatTime(pos) : `-${formatTime(Math.max(0, duration - pos))}`;
      if (text !== last && ref.current) ref.current.textContent = last = text;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [duration, part]);
  return <span className={`time-readout is-${part}`} ref={ref} aria-hidden="true" />;
}
