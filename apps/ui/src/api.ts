import type { CadenceApi } from '@cadence/protocol';
import { MockCadenceApi } from './mock/MockCadenceApi';

/** Prefer the real preload bridge; fall back to the full-session mock in vite dev. */
export function resolveApi(): CadenceApi {
  if (typeof window !== 'undefined' && window.cadence) return window.cadence;
  // Inside the real Electron shell a missing bridge is a preload failure —
  // show the fake data would hide it. Only browsers (vite dev) get the mock.
  if (typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron')) {
    throw new Error('preload bridge unavailable (window.cadence missing)');
  }
  return new MockCadenceApi();
}
