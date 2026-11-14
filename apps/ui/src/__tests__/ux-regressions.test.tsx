import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  PlaybackSnapshot,
  QueueItem,
  QueueState,
  TrackRef,
} from '@cadence/protocol';
import { createUiStore, type StoreApiSurface } from '../store';
import { historyReducer, INITIAL_HISTORY, sameLocation, type History, type Location } from '../navigation';
import { ProviderSearchView } from '../components/provider/views';
import appSource from '../App.tsx?raw';

/** Run a list of navigations from the start page. */
function visit(...to: Location[]): History {
  return to.reduce((history, next) => historyReducer(history, { kind: 'navigate', to: next }), INITIAL_HISTORY);
}
import topBarSource from '../components/TopBar.tsx?raw';
import viewsSource from '../components/provider/views.tsx?raw';

/**
 * Regressions from the ui/cider-v3 merge absorbing the Apple Music provider
 * nav: the search field dropped the typed query on the way to the catalog search,
 * Local Files search bounced into the streaming library while Apple was
 * active, and the immersive now-playing flag survived a queue clear so the
 * next track reopened it unasked.
 *
 * The query handoff and the localfiles tab routing are navigation-shaped, so
 * they are covered by the history reducer plus SSR markup; the wiring that
 * only a mounted session can exercise is asserted on component sources,
 * matching transport-names.test.tsx.
 */

function track(id: string): TrackRef {
  return {
    id,
    route: 'local',
    provider: 'local',
    title: `Track ${id}`,
    artists: [{ name: 'Test Artist' }],
    album: 'Test Album',
    durationMs: 200_000,
    source: { kind: 'file', path: `/music/${id}.flac` },
    availability: 'available',
  };
}

function snap(over: Partial<PlaybackSnapshot> = {}): PlaybackSnapshot {
  return {
    status: 'playing',
    lease: { generationId: 1, route: 'local', queueId: 'q-a', issuedAtMs: 0 },
    current: { queueId: 'q-a', track: track('a') },
    positionMs: 1000,
    positionAtMs: 1000,
    durationMs: 200_000,
    volume: 0.8,
    muted: false,
    ...over,
  };
}

function stoppedSnap(): PlaybackSnapshot {
  return snap({ status: 'stopped', lease: null, current: null, positionMs: 0 });
}

async function makeSession(initial: PlaybackSnapshot) {
  const api: StoreApiSurface = {
    sendCommand: async () => undefined,
    onEvent: () => () => {},
    getSnapshot: async () => initial,
    getQueue: async (): Promise<QueueState> => ({
      owner: 'coordinator',
      items: [{ queueId: 'q-a', track: track('a') } satisfies QueueItem],
      currentIndex: 0,
      shuffle: false,
      repeat: 'off',
    }),
    getCapabilities: async () => [],
    library: { onScanProgress: () => () => {} },
  };
  const session = createUiStore(api);
  await session.init();
  return session;
}

describe('catalog search handoff', () => {
  it('the top bar search carries the typed query into the search location', () => {
    const openSearch = topBarSource.match(/const openSearch = \(query: string\) => \{([\s\S]*?)\n  \};/);
    expect(openSearch).not.toBeNull();
    const nav = openSearch![1]!.match(/onNavigate\(\{ page: 'search'[^;]*\}\)/);
    expect(nav).not.toBeNull();
    expect(nav![0]).toContain('query');
  });

  it('search locations are distinct by query, so resubmits still navigate', () => {
    expect(sameLocation({ page: 'search' }, { page: 'search' })).toBe(true);
    expect(sameLocation({ page: 'search', query: 'a' }, { page: 'search' })).toBe(false);
    expect(sameLocation({ page: 'search', query: 'a' }, { page: 'search', query: 'a' })).toBe(true);
    expect(sameLocation({ page: 'search', query: 'a' }, { page: 'search', query: 'b' })).toBe(false);
  });

  it('ProviderSearchView opens with the carried query in the field and submitted', () => {
    const nav = { openAlbum() {}, openPlaylist() {}, openArtist() {} };
    const html = renderToStaticMarkup(<ProviderSearchView nav={nav} query="midnight sun" />);
    expect(html).toContain('value="midnight sun"');
    // The empty-state prompt only renders when nothing was submitted.
    expect(html).not.toContain('Search the catalog');
  });

  it('clears the field when the location query goes absent (Back, blank Search)', () => {
    // No DOM harness in this suite (environment: 'node'), so the adopt
    // effect is asserted on source: an absent query must reset text to ''.
    const effect = viewsSource.match(/useEffect\(\(\) => \{\s*const q = query \?\? '';\s*setText\(q\);\s*setDebounced\(q\.trim\(\)\);\s*\}, \[query, nonce\]\)/);
    expect(effect).not.toBeNull();
  });

  it('repeat submissions of the same query still reach the view via a nonce', () => {
    // sameLocation dedupes on query alone, so every search submission gets a
    // fresh nonce: the view resets its field even when the query is unchanged.
    const first = visit({ page: 'search', query: 'a' });
    const again = historyReducer(first, { kind: 'navigate', to: { page: 'search', query: 'a' } });
    expect(again.location).toMatchObject({ page: 'search', query: 'a' });
    expect(again.location).not.toEqual(first.location);
    // The repeat updates in place: Back still leaves search in one step.
    expect(again.back).toEqual(first.back);
  });

  it('a local search rides the library location the same way', () => {
    const first = visit({ page: 'library', tab: 'songs', query: 'cairn' });
    expect(first.location).toMatchObject({ page: 'library', tab: 'songs', query: 'cairn' });
    const again = historyReducer(first, { kind: 'navigate', to: { page: 'library', tab: 'songs', query: 'cairn' } });
    expect(again.location).not.toEqual(first.location);
    expect(again.back).toEqual(first.back);
  });
});

describe('history', () => {
  it('goes back and forward through visited pages', () => {
    const there = visit({ page: 'browse' }, { page: 'radio' });
    const back = historyReducer(there, { kind: 'back' });
    expect(back.location).toEqual({ page: 'browse' });
    expect(historyReducer(back, { kind: 'forward' }).location).toEqual({ page: 'radio' });
  });

  it('navigating to the page already shown adds no history', () => {
    const once = visit({ page: 'browse' });
    expect(historyReducer(once, { kind: 'navigate', to: { page: 'browse' } })).toBe(once);
  });

  it('a new navigation drops the forward stack', () => {
    const back = historyReducer(visit({ page: 'browse' }, { page: 'radio' }), { kind: 'back' });
    expect(historyReducer(back, { kind: 'navigate', to: { page: 'sources' } }).forward).toEqual([]);
  });

  it('switching Settings section replaces the entry, so one Back leaves Settings', () => {
    const settings = visit(
      { page: 'browse' },
      { page: 'settings', section: 'accounts' },
      { page: 'settings', section: 'audio' },
      { page: 'settings', section: 'appearance' },
    );
    expect(settings.location).toEqual({ page: 'settings', section: 'appearance' });
    expect(settings.back).toEqual([{ page: 'home' }, { page: 'browse' }]);
    const out = historyReducer(settings, { kind: 'back' });
    expect(out.location).toEqual({ page: 'browse' });
    // Forward returns to the section last shown.
    expect(historyReducer(out, { kind: 'forward' }).location).toEqual({ page: 'settings', section: 'appearance' });
  });

  it('Close settings goes Back, which after section switches is the page before Settings', () => {
    const gear = topBarSource.match(/if \(!settingsOpen\)[^;]*;\s*else if \(canGoBack\) onBack\(\);/);
    expect(gear).not.toBeNull();
  });
});

describe('local files under an active provider', () => {
  it('localfiles locations are distinct by tab, so the search auto-jump navigates', () => {
    expect(sameLocation({ page: 'localfiles', tab: 'albums' }, { page: 'localfiles', tab: 'albums' })).toBe(true);
    expect(sameLocation({ page: 'localfiles', tab: 'albums' }, { page: 'localfiles', tab: 'songs' })).toBe(false);
  });

  it('the localfiles search-jump stays inside the localfiles location', () => {
    const block = appSource.match(/location\.page === 'localfiles' && \(\s*<LibraryView[\s\S]*?\/>\s*\)\}/);
    expect(block).not.toBeNull();
    // tab changes must not resolve through 'library' — under a streaming
    // platform that location renders the provider library, not local files.
    expect(block![0]).toContain("navigate({ page: 'localfiles'");
    expect(block![0]).not.toContain("page: 'library'");
  });
});

describe('immersive now-playing cleanup', () => {
  it('clears nowPlayingExpanded when a snapshot drops the current track', async () => {
    const session = await makeSession(snap());
    session.setNowPlayingExpanded(true);
    expect(session.store.getState().nowPlayingExpanded).toBe(true);
    session.dispatch({ kind: 'snapshot', snapshot: stoppedSnap() });
    expect(session.store.getState().nowPlayingExpanded).toBe(false);
  });

  it('a track started after the clear does not reopen the overlay', async () => {
    const session = await makeSession(snap());
    session.setNowPlayingExpanded(true);
    session.dispatch({ kind: 'snapshot', snapshot: stoppedSnap() });
    session.dispatch({ kind: 'snapshot', snapshot: snap({ current: { queueId: 'q-b', track: track('b') } }) });
    expect(session.store.getState().nowPlayingExpanded).toBe(false);
  });

  it('refuses to set the flag while nothing is loaded', async () => {
    const session = await makeSession(stoppedSnap());
    session.setNowPlayingExpanded(true);
    expect(session.store.getState().nowPlayingExpanded).toBe(false);
    session.dispatch({ kind: 'snapshot', snapshot: snap() });
    session.setNowPlayingExpanded(true);
    expect(session.store.getState().nowPlayingExpanded).toBe(true);
  });
});
