import { afterEach, describe, expect, it, vi } from 'vitest';

/** Load collection.ts fresh against a stubbed localStorage holding `raw`. */
async function loadWith(raw: string) {
  vi.resetModules();
  vi.stubGlobal('localStorage', {
    getItem: () => raw,
    setItem: () => undefined,
  });
  return import('../collection');
}

afterEach(() => vi.unstubAllGlobals());

describe('collection hydration', () => {
  it('resets non-array fields from corrupt storage', async () => {
    const { collection } = await loadWith(JSON.stringify({ pins: 'x', favorites: null, recent: {} }));
    expect(collection.getState()).toEqual({ pins: [], favorites: [], recent: [] });
  });

  it('keeps valid arrays', async () => {
    const { collection } = await loadWith(JSON.stringify({ pins: [], favorites: [], recent: ['a\u0000b'] }));
    expect(collection.getState().recent).toEqual(['a\u0000b']);
  });
});
