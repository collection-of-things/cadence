import type { CadenceApi } from '@cadence/protocol';
import { MockCadenceApi } from './mock/MockCadenceApi';

/** Prefer the real preload bridge; fall back to the full-session mock in vite dev. */
export function resolveApi(): CadenceApi {
  if (typeof window !== 'undefined' && window.cadence) return window.cadence;
  // Headless screenshot capture loads the UI inside Electron — opt back
  // into the mock explicitly via ?cadence_mock=1.
  const wantsMock =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('cadence_mock');
  if (
    !wantsMock &&
    typeof navigator !== 'undefined' &&
    navigator.userAgent.includes('Electron')
  ) {
    // Inside the real Electron shell a missing bridge is a preload failure —
    // show the fake data would hide it.
    throw new Error('preload bridge unavailable (window.cadence missing)');
  }
  return new MockCadenceApi();
}
