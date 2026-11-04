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

async function sample(url: string): Promise<Rgb[] | null> {
  const img = new Image();
  img.decoding = 'async';
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
  return top.length ? top : null;
}
