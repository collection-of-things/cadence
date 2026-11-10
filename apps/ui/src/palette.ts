import { useEffect, useState } from 'react';

export type Rgb = [number, number, number];

export const DEFAULT_PALETTE: Rgb[] = [
  [72, 88, 150],
  [38, 44, 78],
  [18, 20, 34],
];

const cache = new Map<string, Promise<Rgb[] | null>>();

/**
 * Extract up to 3 representative colors from artwork. Saturated, mid-luma
 * pixels win; the result feeds the ambient shader and accent variables.
 * Returns null when the image cannot be sampled (tainted, missing, decode fail).
 */
export function extractPalette(url: string): Promise<Rgb[] | null> {
  let p = cache.get(url);
  if (!p) {
    p = sample(url).catch(() => null);
    cache.set(url, p);
  }
  return p;
}

/** The palette of a cover, or the default until it is sampled or when there is no cover. */
export function useArtworkPalette(url: string | undefined): Rgb[] {
  const [palette, setPalette] = useState<Rgb[]>(DEFAULT_PALETTE);
  useEffect(() => {
    let live = true;
    if (!url) {
      setPalette(DEFAULT_PALETTE);
      return;
    }
    void extractPalette(url).then((result) => {
      if (live) setPalette(result ?? DEFAULT_PALETTE);
    });
    return () => {
      live = false;
    };
  }, [url]);
  return palette;
}

async function sample(url: string): Promise<Rgb[] | null> {
  const img = new Image();
  img.decoding = 'async';
  // Ask for CORS so the canvas stays readable: without it every remote or
  // cadence-art:// cover taints the canvas and sampling silently fails.
  img.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('decode'));
    img.src = url;
  });
  const size = 24;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;

  // Score each pixel by saturation * mid-luma weight; keep the best per hue bucket.
  const buckets = new Map<number, { score: number; rgb: Rgb }>();
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]! / 255;
    const g = data[i + 1]! / 255;
    const b = data[i + 2]! / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const sat = max === 0 ? 0 : (max - min) / max;
    const score = sat * (1 - Math.abs(luma - 0.45) * 1.6) * max;
    if (score <= 0.02) continue;
    const bucket = Math.floor(max * 8) * 32 + Math.floor(min * 4); // coarse chroma cell
    const cur = buckets.get(bucket);
    if (!cur || score > cur.score) {
      buckets.set(bucket, { score, rgb: [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)] });
    }
  }
  const top = [...buckets.values()].sort((a, b) => b.score - a.score).slice(0, 3).map((v) => v.rgb);
  return top.length ? top.map(liftColor) : null;
}

/* Lift a sampled colour toward the wash's usable range: a murky dark
 * extraction gets saturation and mid-luma so it can carry an atmosphere
 * instead of dimming the page. HSL-space lift, no lib. */
function liftColor(rgb: Rgb): Rgb {
  const [r0, g0, b0] = rgb.map((v) => v / 255) as [number, number, number];
  const max = Math.max(r0, g0, b0);
  const min = Math.min(r0, g0, b0);
  const l = (max + min) / 2;
  const d = max - min;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let hue = 0;
  if (d !== 0) {
    if (max === r0) hue = 60 * (((g0 - b0) / d) % 6);
    else if (max === g0) hue = 60 * ((b0 - r0) / d + 2);
    else hue = 60 * ((r0 - g0) / d + 4);
  }
  if (hue < 0) hue += 360;
  const sat2 = Math.max(sat, 0.42);           // chroma floor
  const l2 = Math.min(0.62, Math.max(0.38, l + (l < 0.35 ? 0.14 : 0))); // luma band
  const c = (1 - Math.abs(2 * l2 - 1)) * sat2;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l2 - c / 2;
  const seg = Math.floor(hue / 60) % 6;
  const [rp, gp, bp] = ([[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]] as const)[seg]!;
  return [Math.round((rp + m) * 255), Math.round((gp + m) * 255), Math.round((bp + m) * 255)];
}
