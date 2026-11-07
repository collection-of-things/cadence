import { useEffect, useState } from 'react';
import { useStore } from 'zustand/react';
import { session } from './session';
import type { UiState } from './store';

/** Subscribe to the UI store. */
export function useUi<T>(selector: (s: UiState) => T): T {
  return useStore(session.store, selector);
}

const QUERY = '(prefers-reduced-motion: reduce)';

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => (typeof matchMedia !== 'undefined' ? matchMedia(QUERY).matches : false));
  useEffect(() => {
    const mq = matchMedia(QUERY);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** Position of the playhead right now, interpolated between coordinator events. */
export function positionNow(): number {
  const c = session.runtime.clock;
  const pos = c.playing ? c.positionMs + (Date.now() - c.atMs) : c.positionMs;
  return c.durationMs > 0 ? Math.min(pos, c.durationMs) : Math.max(0, pos);
}

/**
 * Mirrors the current track and transport into the OS media session
 * (taskbar/media keys) when the platform exposes navigator.mediaSession.
 */
export function useMediaSession(): void {
  const track = useUi((s) => s.snapshot.current?.track);
  const status = useUi((s) => s.snapshot.status);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.playbackState = status === 'playing' ? 'playing' : status === 'paused' ? 'paused' : 'none';
    if (!track) {
      ms.metadata = null;
      return;
    }
    const art = track.artwork;
    ms.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artists.map((a) => a.name).join(', '),
      ...(track.album ? { album: track.album } : {}),
      ...(art?.url
        ? { artwork: [{ src: art.url, ...(art.width && art.height ? { sizes: `${art.width}x${art.height}` } : {}) }] }
        : {}),
    });
  }, [track, status]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      [
        'play',
        () => {
          if (session.store.getState().snapshot.status !== 'playing') session.togglePlay();
        },
      ],
      [
        'pause',
        () => {
          if (session.store.getState().snapshot.status === 'playing') session.togglePlay();
        },
      ],
      ['previoustrack', () => session.previous()],
      ['nexttrack', () => session.next()],
      [
        'seekto',
        (d) => {
          if (d.seekTime != null) session.seek(d.seekTime * 1000);
        },
      ],
    ];
    for (const [action, handler] of handlers) {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        // Platform does not support this action — skip it.
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          ms.setActionHandler(action, null);
        } catch {
          // ignore
        }
      }
    };
  }, []);
}
