import type { CadenceApi } from '@cadence/protocol';
import { MockCadenceApi } from './mock/MockCadenceApi';

/** Prefer the preload bridge; use the mock in previews or when explicitly requested. */
export function resolveApi(): CadenceApi {
  if (typeof window !== 'undefined' && window.cadence) return window.cadence;
  const wantsMock =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('cadence_mock');
  if (
    !wantsMock &&
    typeof navigator !== 'undefined' &&
    navigator.userAgent.includes('CadenceShell')
  ) {
    // Mock data would hide a preload failure in the real Cadence window.
    throw new Error('preload bridge unavailable (window.cadence missing)');
  }
  return new MockCadenceApi();
}
