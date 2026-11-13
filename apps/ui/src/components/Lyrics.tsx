import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TrackRef } from '@cadence/protocol';
import { positionNow, prefersReducedMotion } from '../hooks';
import { session } from '../session';
import { formatTime } from '../format';
import { useTrackLyrics, type TrackLyrics } from './useTrackLyrics';

type Line = { time: number; text: string };

/** Parse LRC text into timed lines. An `[offset:]` tag follows the LRC convention: positive shows lines sooner. */
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
      lines.push({ time: Number(stamp[1]) * 60000 + Number(stamp[2]) * 1000 + Number((stamp[3] ?? '').padEnd(3, '0')) - offsetMs, text });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

/** Scroll the viewport so `line` sits in its vertical centre. */
function centreOn(viewport: HTMLElement, line: HTMLElement, behavior: ScrollBehavior): void {
  viewport.scrollTo({ top: line.offsetTop - viewport.clientHeight / 2 + line.clientHeight / 2, behavior });
}

const activeLine = (viewport: HTMLElement | null) => viewport?.querySelector<HTMLElement>('[data-lyric].active') ?? null;

/** One sync nudge, in milliseconds. */
const NUDGE_MS = 250;
/** The desktop app clamps nudges to this range either way. */
const MAX_OFFSET_MS = 30_000;

const formatOffset = (ms: number) => `${ms > 0 ? '+' : '\u2212'}${(Math.abs(ms) / 1000).toFixed(2)}s`;

/**
 * Controls a local track gets under its lyrics: attach a downloaded lyrics
 * file, and for synced lyrics shift every line earlier or later.
 */
function LyricsTools({ lyrics, synced }: { lyrics: TrackLyrics; synced: boolean }) {
  const { tools, offsetMs } = lyrics;
  if (!tools) return null;
  return (
    <div className="lyrics-tools" role="group" aria-label="Lyrics file and timing">
      {synced && (
        <>
          <button aria-label="Show lyrics earlier" title="Lyrics earlier" disabled={offsetMs <= -MAX_OFFSET_MS} onClick={() => tools.setOffset(offsetMs - NUDGE_MS)}>
            {'\u2212'}
          </button>
          <button className="lyrics-offset" aria-label="Reset lyrics timing" title="Reset timing" disabled={offsetMs === 0} onClick={() => tools.setOffset(0)}>
            {offsetMs === 0 ? 'Sync' : formatOffset(offsetMs)}
          </button>
          <button aria-label="Show lyrics later" title="Lyrics later" disabled={offsetMs >= MAX_OFFSET_MS} onClick={() => tools.setOffset(offsetMs + NUDGE_MS)}>
            +
          </button>
        </>
      )}
      <button onClick={tools.importFile}>{lyrics.text?.trim() ? 'Replace file' : 'Add lyrics file'}</button>
    </div>
  );
}

/**
 * Lyrics for the playing track. Synced (LRC) lyrics follow the playhead and
 * seek when a line is clicked; scrolling by hand pauses the follow until the
 * "Follow lyrics" button is pressed. Plain text shows as is. Local files also
 * get the file and timing tools.
 */
export function Lyrics({ track }: { track: TrackRef }) {
  const lyrics = useTrackLyrics(track);
  const raw = lyrics.text;
  const lines = useMemo(() => parseLyrics(raw ?? ''), [raw]);
  // Read every frame, so a nudge lands without restarting the follow loop.
  const offsetRef = useRef(lyrics.offsetMs);
  useLayoutEffect(() => {
    offsetRef.current = lyrics.offsetMs;
  }, [lyrics.offsetMs]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const manualUntil = useRef(0);
  const [following, setFollowing] = useState(true);
  const unpause = useCallback((ms = 4500) => {
    manualUntil.current = Date.now() + ms;
    const viewport = scrollRef.current;
    const target = activeLine(viewport);
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
    const target = activeLine(viewport);
    if (viewport && target) centreOn(viewport, target, prefersReducedMotion() ? 'instant' : 'smooth');
  }, []);
  useEffect(() => {
    if (!lines.length) return;
    let frame = 0;
    let active = -2;
    let activeWasInitial = true;
    const tick = () => {
      const position = positionNow() - offsetRef.current;
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
            // First position set snaps; subsequent line changes glide.
            const instant = prefersReducedMotion() || activeWasInitial;
            centreOn(viewport, target, instant ? 'instant' : 'smooth');
            setFollowing(true);
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const onResize = () => {
      const viewport = scrollRef.current;
      const target = activeLine(viewport);
      if (viewport && target && Date.now() > manualUntil.current) centreOn(viewport, target, 'instant');
    };
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
    };
  }, [lines]);

  if (!raw?.trim()) {
    return (
      <>
        <div className="lyrics-empty">No lyrics available for this track.</div>
        <LyricsTools lyrics={lyrics} synced={false} />
      </>
    );
  }
  if (!lines.length) {
    return (
      <>
        <div className="lyrics-plain">{raw}</div>
        <LyricsTools lyrics={lyrics} synced={false} />
      </>
    );
  }
  return (
    <>
      <div
        className="lyrics-scroll"
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
            title={`Jump to ${formatTime(Math.max(0, line.time + lyrics.offsetMs))}`}
            onClick={() => session.seek(line.time + lyrics.offsetMs)}
          >
            {line.text}
          </p>
        ))}
      </div>
      <LyricsTools lyrics={lyrics} synced />
      {!following && (
        <button className="lyrics-follow" onClick={follow}>Follow lyrics</button>
      )}
    </>
  );
}
