import type { CSSProperties } from 'react';
import type { Rgb } from './palette';
import { DEFAULT_PALETTE } from './palette';

/** CSS colour variables the shell derives from the playing artwork. */
export interface Theme {
  /** Vivid accent for play buttons, progress and the current row. */
  acc: Rgb;
  /** Text colour on top of `acc`. */
  accInk: Rgb;
  /** Two deep tones for the ambient wash and the bottom fade. */
  amb1: Rgb;
  amb2: Rgb;
  /** Four shader colours: two deep washes, the accent and a hue-shifted partner. */
  field: [Rgb, Rgb, Rgb, Rgb];
}

type Hsl = [number, number, number];

function toHsl([r0, g0, b0]: Rgb): Hsl {
  const r = r0 / 255;
  const g = g0 / 255;
  const b = b0 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function fromHsl([h0, s, l]: Hsl): Rgb {
  const h = ((h0 % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The palette as a non-empty list, falling back to the default when sampling failed. */
function swatchesOf(palette: Rgb[]): [Rgb, ...Rgb[]] {
  const [head, ...rest] = palette.length ? palette : DEFAULT_PALETTE;
  return head ? [head, ...rest] : [[72, 88, 150]];
}

/**
 * Turn an artwork palette into the shell's colours. The most saturated
 * swatch becomes the accent, pushed into a lightness band that reads on
 * near-black; the deep tones come from the first two swatches. A fixed
 * `accent` (Settings, Appearance) replaces the artwork's own.
 */
export function themeFromPalette(palette: Rgb[], accent?: Rgb): Theme {
  const swatches = swatchesOf(palette);
  const [first, second = first] = swatches;
  const vivid = swatches.reduce((best, c) => (toHsl(c)[1] > toHsl(best)[1] ? c : best), first);
  const [h, s, l] = toHsl(accent ?? vivid);
  const acc = fromHsl([h, clamp(s, 0.5, 0.9), clamp(l, 0.6, 0.72)]);
  const accInk = fromHsl([h, 0.6, 0.07]);
  const deep = (c: Rgb, light: number) => {
    const [ch, cs] = toHsl(c);
    return fromHsl([ch, clamp(cs, 0.3, 0.7), light]);
  };
  const amb1 = deep(first, 0.2);
  const amb2 = deep(second, 0.11);
  const partner = fromHsl([h + 56, clamp(s, 0.55, 0.85), clamp(l * 0.66, 0.3, 0.5)]);
  const field: Theme['field'] = [amb1, amb2, acc, scale(mix(partner, amb1, 0.2), 0.6)];
  return { acc, accInk, amb1, amb2, field };
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function scale(c: Rgb, k: number): Rgb {
  return [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k)];
}

const css = ([r, g, b]: Rgb) => `rgb(${r} ${g} ${b})`;

/** Write a theme onto :root so every surface (and every portal) picks it up. */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.style.setProperty('--acc', css(theme.acc));
  root.style.setProperty('--acc-ink', css(theme.accInk));
  root.style.setProperty('--amb1', css(theme.amb1));
  root.style.setProperty('--amb2', css(theme.amb2));
}

/**
 * Inline style for an album or playlist page: the cover's own accent (so
 * Play and the playing row match this cover, not the track playing) and two
 * tints that flood the page from the top.
 */
export function pageTheme(palette: Rgb[], accent?: Rgb): CSSProperties {
  const theme = themeFromPalette(palette, accent);
  const swatches = swatchesOf(palette);
  const [first, second = first] = swatches;
  const vivid = swatches.reduce((best, c) => (toHsl(c)[1] > toHsl(best)[1] ? c : best), first);
  const [h, s] = toHsl(vivid);
  const [h2, s2] = toHsl(second);
  return {
    '--acc': css(theme.acc),
    '--acc-ink': css(theme.accInk),
    '--page-tint': css(fromHsl([h, clamp(s, 0.3, 0.62), 0.25])),
    '--page-tint-2': css(fromHsl([h2, clamp(s2, 0.25, 0.6), 0.15])),
  };
}
