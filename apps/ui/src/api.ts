import type { CadenceApi } from '@cadence/protocol';
import { MockCadenceApi } from './mock/MockCadenceApi';

/** Prefer the real preload bridge; fall back to the full-session mock in vite dev. */
export function resolveApi(): CadenceApi {
  if (typeof window !== 'undefined' && window.cadence) return window.cadence;
  return new MockCadenceApi();
}
