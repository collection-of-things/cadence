import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveApi } from '../api';
import { MockCadenceApi } from '../mock/MockCadenceApi';

afterEach(() => vi.unstubAllGlobals());

describe('resolveApi in Electron', () => {
  it('uses the mock in an Electron preview without a preload bridge', () => {
    vi.stubGlobal('navigator', { userAgent: 'Electron/45.2.1' });
    expect(resolveApi()).toBeInstanceOf(MockCadenceApi);
  });

  it('reports a missing preload in the Cadence shell', () => {
    vi.stubGlobal('navigator', { userAgent: 'Electron/45.2.1 CadenceShell' });
    expect(resolveApi).toThrow('preload bridge unavailable');
  });
});
