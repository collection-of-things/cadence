/** Keep ordinary playback clock corrections gradual; explicit seeks remain immediate. */
export function smoothPlayhead(
  target: number,
  time: number,
  previous: { position: number; time: number; revision: number } | undefined,
  playing: boolean,
  revision: number,
): number {
  if (!previous || !playing || revision !== previous.revision) return target;
  const elapsed = time - previous.time;
  if (elapsed <= 0 || elapsed > 1000) return target;
  const predicted = previous.position + elapsed;
  const error = target - predicted;
  if (Math.abs(error) > 5000) return target;
  // Provider clocks can tick in coarse steps. Keep an even speed inside
  // that uncertainty and correct larger drift slowly, without reversing.
  const drift = Math.sign(error) * Math.max(0, Math.abs(error) - 750);
  return predicted + Math.max(-elapsed * 0.05, Math.min(elapsed * 0.05, drift * elapsed / 5000));
}
