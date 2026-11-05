import { useEffect, useMemo, useRef } from 'react';
import { positionNow } from '../hooks';

type Line = { time: number; text: string };

function parseLyrics(raw: string): Line[] {
  const lines: Line[] = [];
  for (const row of raw.split(/\r?\n/)) {
    const stamps = [...row.matchAll(/\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const text = row.replace(/\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/g, '').trim();
    if (!text) continue;
    for (const stamp of stamps) {
      lines.push({ time: Number(stamp[1]) * 60000 + Number(stamp[2]) * 1000 + Number((stamp[3] ?? '').padEnd(3, '0')), text });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

export function Lyrics({ raw }: { raw: string | undefined }) {
  const lines = useMemo(() => parseLyrics(raw ?? ''), [raw]);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!lines.length) return;
    let frame = 0;
    let active = -2;
    const tick = () => {
      const position = positionNow();
      let next = -1;
      for (let i = 0; i < lines.length && lines[i]!.time <= position; i++) next = i;
      if (next !== active) {
        active = next;
        const viewport = scrollRef.current;
        if (viewport) {
          const elements = viewport.querySelectorAll<HTMLElement>('[data-lyric]');
          elements.forEach((el, i) => {
            el.classList.toggle('active', i === next);
            el.classList.toggle('past', i < next);
          });
          const target = elements[Math.max(0, next)];
          if (target) viewport.scrollTo({ top: target.offsetTop - viewport.clientHeight / 2 + target.clientHeight / 2, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [lines]);

  if (!raw?.trim()) return <div className="full-lyrics-empty">No lyrics available for this track.</div>;
  if (!lines.length) return <div className="full-lyrics-plain">{raw}</div>;
  return <div className="full-lyrics-scroll" ref={scrollRef} aria-label="Synced lyrics">{lines.map((line, i) => <p data-lyric key={`${line.time}-${i}`}>{line.text}</p>)}</div>;
}
