import type { RouteCapabilities } from '@cadence/protocol';
import { formatOutput } from '../format';
import { useUi } from '../hooks';
import { session } from '../app';

function triLabel(tri: 'yes' | 'no' | 'unknown', label: string): { label: string; tone: 'ok' | 'dim' } | null {
  if (tri === 'yes') return { label, tone: 'ok' };
  if (tri === 'unknown') return { label: `${label}?`, tone: 'dim' };
  return null;
}

/** Honest capability readout for the active route plus negotiated output. */
export function CapabilityChips() {
  const leaseRoute = useUi((s) => s.snapshot.lease?.route);
  const trackRoute = useUi((s) => s.snapshot.current?.track.route);
  const output = useUi((s) => s.snapshot.output);
  const capabilities = useUi((s) => s.capabilities);
  const route = leaseRoute ?? trackRoute;
  if (!route) return null;
  const cap: RouteCapabilities | undefined = capabilities.find((c) => c.route === route);

  const chips: { key: string; label: string; tone: 'ok' | 'warn' | 'dim'; title?: string | undefined }[] = [];
  if (cap) {
    if (cap.state !== 'ready') {
      chips.push({ key: 'state', label: cap.state === 'unauthenticated' ? 'Sign-in required' : cap.state, tone: 'warn', ...(cap.stateDetail ? { title: cap.stateDetail } : {}) });
    }
    const vis = cap.visuals.kind === 'pcm-fft' ? 'PCM FFT' : 'Ambient visuals';
    chips.push({ key: 'vis', label: vis, tone: cap.visuals.kind === 'pcm-fft' ? 'ok' : 'dim', title: cap.notes.join('\n') || undefined });
    const gap = triLabel(cap.playback.gapless, 'Gapless');
    if (gap) chips.push({ key: 'gap', ...gap });
    const eq = triLabel(cap.audio.eq, 'EQ');
    if (eq) chips.push({ key: 'eq', ...eq });
    if (cap.playback.exclusiveOutput === 'yes') {
      chips.push({ key: 'excl', label: 'Exclusive', tone: 'ok' });
    }
    if (cap.audio.qualityCeiling) chips.push({ key: 'q', label: cap.audio.qualityCeiling, tone: 'dim' });
  }
  if (output) {
    chips.push({ key: 'out', label: formatOutput(output), tone: 'ok', title: output.deviceName });
    if (output.fidelityBypass) chips.push({ key: 'fid', label: 'Fidelity bypass', tone: 'ok' });
    if (output.exclusive) chips.push({ key: 'exo', label: 'Exclusive output', tone: 'ok' });
  }

  return (
    <div className="cap-chips">
      {chips.map((c) => (
        <span key={c.key} className={`chip chip-${c.tone}`} title={c.title}>
          {c.label}
        </span>
      ))}
      {cap?.state === 'unauthenticated' && (
        <button className="chip chip-btn" onClick={() => session.signInRoute(route)}>
          Sign in
        </button>
      )}
    </div>
  );
}
