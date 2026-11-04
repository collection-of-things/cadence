import type { ActiveOutput } from '@cadence/protocol';

export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

export function formatOutput(o: ActiveOutput): string {
  const rate = `${(o.sampleRateHz / 1000).toFixed(o.sampleRateHz % 1000 ? 1 : 0)} kHz`;
  const depth = o.bitDepth === 'float' ? 'float' : `${o.bitDepth}-bit`;
  return `${rate} · ${depth}`;
}

export function artistsLine(artists: { name: string }[]): string {
  return artists.map((a) => a.name).join(', ') || 'Unknown Artist';
}
