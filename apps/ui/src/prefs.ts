import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand/react';
import type { Rgb } from './palette';

/**
 * The listener's app preferences, set on the Settings page. Renderer-local
 * and persisted to localStorage (versioned key); playback and audio engine
 * settings live in the desktop app instead and arrive with the snapshot.
 */
export interface Prefs {
  /** Accent colour for buttons and progress: the playing cover's, or a fixed one. */
  accent: AccentId;
  /** Whether the colour field behind the app drifts or holds still. */
  movingBackground: boolean;
  /** How far the left and right arrow keys skip. */
  skipSeconds: SkipSeconds;
  /** Whether Now Playing opens with lyrics beside the artwork. */
  lyricsInNowPlaying: boolean;
}

/** Fixed accents on offer, besides following the artwork. */
export const ACCENTS = [
  { id: 'rose', label: 'Rose', rgb: [250, 88, 120] },
  { id: 'amber', label: 'Amber', rgb: [245, 170, 66] },
  { id: 'mint', label: 'Mint', rgb: [84, 214, 158] },
  { id: 'sky', label: 'Sky', rgb: [92, 170, 250] },
  { id: 'violet', label: 'Violet', rgb: [160, 130, 250] },
] as const satisfies readonly { id: string; label: string; rgb: Rgb }[];

export type AccentId = 'artwork' | (typeof ACCENTS)[number]['id'];

export const SKIP_SECONDS = [5, 10, 15, 30] as const;
export type SkipSeconds = (typeof SKIP_SECONDS)[number];

const DEFAULTS: Prefs = { accent: 'artwork', movingBackground: true, skipSeconds: 5, lyricsInNowPlaying: true };
const KEY = 'cadence.prefs.v1';

const isAccent = (v: unknown): v is AccentId => v === 'artwork' || ACCENTS.some((a) => a.id === v);
const isSkip = (v: unknown): v is SkipSeconds => SKIP_SECONDS.some((s) => s === v);

/** Read stored preferences; anything missing or malformed falls back to its default. */
function load(): Prefs {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (typeof parsed !== 'object' || parsed === null) return DEFAULTS;
    const stored: Partial<Record<keyof Prefs, unknown>> = parsed;
    return {
      accent: isAccent(stored.accent) ? stored.accent : DEFAULTS.accent,
      movingBackground: typeof stored.movingBackground === 'boolean' ? stored.movingBackground : DEFAULTS.movingBackground,
      skipSeconds: isSkip(stored.skipSeconds) ? stored.skipSeconds : DEFAULTS.skipSeconds,
      lyricsInNowPlaying: typeof stored.lyricsInNowPlaying === 'boolean' ? stored.lyricsInNowPlaying : DEFAULTS.lyricsInNowPlaying,
    };
  } catch {
    // Storage blocked or corrupt: start from the defaults.
    return DEFAULTS;
  }
}

export const prefs = createStore<Prefs>(() => load());

prefs.subscribe((state) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Quota or blocked storage: the preference still holds for this session.
  }
});

export function usePrefs<T>(selector: (p: Prefs) => T): T {
  return useStore(prefs, selector);
}

/** Change one or more preferences. */
export function setPrefs(change: Partial<Prefs>): void {
  prefs.setState(change);
}

/** The fixed accent colour for an id; undefined when the accent follows the artwork. */
export function accentRgb(id: AccentId): Rgb | undefined {
  return ACCENTS.find((a) => a.id === id)?.rgb;
}
