import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { positionNow } from '../hooks';
import { session } from '../app';

type Line = { time: number; text: string };

function parseLyrics(raw: string): Line[] {
  const lines: Line[] = [];
  let offsetMs = 0;
  for (const row of raw.split(/\r?\n/)) {
    const off = row.match(/^\[offset:\s*([+-]?\d+)\s*\]$/i);
    if (off) { offsetMs = Number(off[1]); continue; }
    const stamps = [...row.matchAll(/\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const text = row.replace(/\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/g, '').trim();
    if (!text) continue;
    for (const stamp of stamps) {
      lines.push({ time: Number(stamp[1]) * 60000 + Number(stamp[2]) * 1000 + Number((stamp[3] ?? '').padEnd(3, '0')) + offsetMs, text });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

export function Lyrics({ raw }: { raw: string | undefined }) {
  const lines = useMemo(() => parseLyrics(raw ?? ''), [raw]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const manualUntil = useRef(0);
  const [following, setFollowing] = useState(true);
  const unpause = useCallback((ms = 4500) => {
    manualUntil.current = Date.now() + ms;
    const viewport = scrollRef.current;
    const target = viewport?.querySelector<HTMLElement>('[data-lyric].active');
    if (viewport && target) {
      const centre = viewport.clientHeight / 2;
      const lineCentre = target.offsetTop - viewport.scrollTop + target.clientHeight / 2;
      if (Math.abs(lineCentre - centre) < 60) return; // already centred — nothing to follow back to
    }
    setFollowing(false);
  }, []);
  const follow = useCallback(() => {
    manualUntil.current = 0;
    setFollowing(true);
    // Recenter on the active line right now, not on the next line change.
    const viewport = scrollRef.current;
    const target = viewport?.querySelector<HTMLElement>('[data-lyric].active');
    if (viewport && target) {
      viewport.scrollTo({
        top: target.offsetTop - viewport.clientHeight / 2 + target.clientHeight / 2,
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
      });
    }
  }, []);
  useEffect(() => {
    if (!lines.length) return;
    let frame = 0;
    let active = -2;
    let activeWasInitial = true;
    const tick = () => {
      const position = positionNow();
      let next = -1;
      for (let i = 0; i < lines.length && lines[i]!.time <= position; i++) next = i;
      if (next !== active) {
        const wasInitial = active === -2;
        activeWasInitial = wasInitial || Math.abs(next - active) > 1;
        active = next;
        const viewport = scrollRef.current;
        if (viewport) {
          const elements = viewport.querySelectorAll<HTMLElement>('[data-lyric]');
          elements.forEach((el, i) => {
            el.classList.toggle('active', i === next);
            el.classList.toggle('past', i < next);
            const dist = i - next;
            el.classList.toggle('d1', dist === 1);
            el.classList.toggle('d2', dist === 2);
            el.classList.toggle('d3', dist >= 3);
          });
          const target = elements[Math.max(0, next)];
          if (target && Date.now() > manualUntil.current) {
            const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
            // First position set snaps; subsequent line changes glide.
            const instant = reduced || activeWasInitial;
            viewport.scrollTo({ top: target.offsetTop - viewport.clientHeight / 2 + target.clientHeight / 2, behavior: instant ? 'instant' : 'smooth' });
            setFollowing(true);
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const onResize = () => {
      const viewport = scrollRef.current;
      const target = viewport?.querySelector<HTMLElement>('[data-lyric].active');
      if (viewport && target && Date.now() > manualUntil.current) {
        viewport.scrollTo({ top: target.offsetTop - viewport.clientHeight / 2 + target.clientHeight / 2, behavior: 'instant' });
      }
    };
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
    };
  }, [lines]);

  if (!raw?.trim()) return <div className="full-lyrics-empty">No lyrics available for this track.</div>;
  if (!lines.length) return <div className="full-lyrics-plain">{raw}</div>;
  return (
    <>
      <div
        className="full-lyrics-scroll"
        ref={scrollRef}
        aria-label="Synced lyrics"
        tabIndex={0}
        onWheel={() => unpause()}
        onPointerDown={() => unpause(6000)}
        onTouchMove={() => unpause(6000)}
        onKeyDown={(e) => {
          const el = scrollRef.current;
          if (!el) return;
          const step = e.key === 'PageDown' ? el.clientHeight : e.key === 'PageUp' ? -el.clientHeight
            : e.key === 'ArrowDown' ? 64 : e.key === 'ArrowUp' ? -64 : 0;
          if (step) {
            e.preventDefault();
            unpause(6000);
            el.scrollBy({ top: step });
          }
        }}
      >
        {lines.map((line, i) => (
          <p
            data-lyric
            key={`${line.time}-${i}`}
            tabIndex={-1}
            title={`Jump to ${Math.floor(line.time / 60000)}:${String(Math.floor((line.time % 60000) / 1000)).padStart(2, '0')}`}
            onClick={() => session.seek(line.time)}
          >
            {line.text}
          </p>
        ))}
      </div>
      {!following && (
        <button className="full-lyrics-follow" onClick={follow}>Follow lyrics</button>
      )}
    </>
  );
}
