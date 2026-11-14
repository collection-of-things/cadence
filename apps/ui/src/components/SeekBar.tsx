import { useEffect, useRef } from 'react';
import { session } from '../session';
import { formatTime } from '../format';
import { positionNow, useUi } from '../hooks';
import { activeCapabilities } from '../routes';
import { smoothPlayhead } from './smoothPlayhead';
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
  const trackId = useUi((s) => s.snapshot.current?.queueId);
  const wrapRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);

  useEffect(() => {
    let raf = 0;
    let previous: { position: number; time: number; revision: number } | undefined;
    const loop = (time: number) => {
      raf = requestAnimationFrame(loop);
      const input = inputRef.current;
      const wrap = wrapRef.current;
      if (!input || !wrap) return;
      if (scrubbing.current) { previous = undefined; return; }
      const clock = session.runtime.clock;
      const pos = smoothPlayhead(positionNow(), time, previous, clock.playing, clock.seekRevision);
      previous = { position: pos, time, revision: clock.seekRevision };
      input.value = String(Math.round(pos));
      paintPosition(pos);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); scrubbing.current = false; };
  }, [duration, trackId]);

  const paintPosition = (position: number) => {
    const wrap = wrapRef.current;
    const knob = knobRef.current;
    if (!wrap || !knob) return;
    const ratio = duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0;
    wrap.style.setProperty('--p', String(ratio));
    knob.style.transform = `translate3d(${ratio * wrap.clientWidth}px, 0, 0)`;
  };

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
        <span className="seek-knob" ref={knobRef} aria-hidden="true" />
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
            scrubbing.current = true;
            paintPosition(Number(e.currentTarget.value));
          }}
          onPointerUp={commit}
          onPointerCancel={() => { scrubbing.current = false; }}
          onKeyDown={(e) => {
            const delta = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 5000
              : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -5000
              : e.key === 'PageUp' ? duration / 10 : e.key === 'PageDown' ? -duration / 10
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
