import { beforeEach, describe, expect, it } from 'vitest';
import type {
  CoordinatorEvent,
  PlaybackCommand,
  PlaybackSnapshot,
  QueueItem,
  QueueState,
  TrackRef,
} from '@cadence/protocol';
import { createUiStore, displayOrder, nextQueueIndex, type StoreApiSurface, type UiSession } from '../store';

function track(id: string, route: TrackRef['route'] = 'local'): TrackRef {
  return {
    id,
    route,
    provider: 'local',
    title: `Track ${id}`,
    artists: [{ name: 'Test Artist' }],
    album: 'Test Album',
    durationMs: 200_000,
    source: { kind: 'file', path: `/music/${id}.flac` },
    availability: 'available',
  };
}

function qItem(id: string): QueueItem {
  return { queueId: `q-${id}`, track: track(id) };
}

function queue(items: QueueItem[], over: Partial<QueueState> = {}): QueueState {
  return { owner: 'coordinator', items, currentIndex: 0, shuffle: false, repeat: 'off', ...over };
}

function snap(over: Partial<PlaybackSnapshot> = {}): PlaybackSnapshot {
  return {
    status: 'playing',
    lease: { generationId: 1, route: 'local', queueId: 'q-a', issuedAtMs: 0 },
    current: qItem('a'),
    positionMs: 1000,
    positionAtMs: 1000,
    durationMs: 200_000,
    volume: 0.8,
    muted: false,
    ...over,
  };
}

interface FakeApi {
  api: StoreApiSurface;
  sent: PlaybackCommand[];
  emit(e: CoordinatorEvent): void;
}

function makeApi(initial: { snapshot?: PlaybackSnapshot; queue?: QueueState } = {}): FakeApi {
  const sent: PlaybackCommand[] = [];
  let cb: ((e: CoordinatorEvent) => void) | null = null;
  return {
    sent,
    emit: (e) => cb?.(e),
    api: {
      sendCommand: async (c) => {
        sent.push(c);
      },
      onEvent: (f) => {
        cb = f;
        return () => {
          cb = null;
        };
      },
      getSnapshot: async () => initial.snapshot ?? snap(),
      getQueue: async () => initial.queue ?? queue([qItem('a'), qItem('b'), qItem('c')]),
      getCapabilities: async () => [],
      library: { onScanProgress: () => () => {} },
    },
  };
}

let session: UiSession;
let fake: FakeApi;

beforeEach(async () => {
  fake = makeApi();
  session = createUiStore(fake.api);
  await session.init();
});

describe('init', () => {
  it('loads snapshot, queue and capabilities', () => {
    const s = session.store.getState();
    expect(s.ready).toBe(true);
    expect(s.snapshot.status).toBe('playing');
    expect(s.queue.items).toHaveLength(3);
    expect(s.generationId).toBe(1);
  });

  it('keeps authorization events received while the initial capability request is pending', async () => {
    const api = makeApi();
    const { MockCadenceApi } = await import('../mock/MockCadenceApi');
    const mock = new MockCadenceApi();
    const apple = (await mock.getCapabilities()).find(c => c.route === 'apple-musickit')!;
    mock.dispose();
    let release!: (value: typeof apple[]) => void;
    api.api.getCapabilities = () => new Promise(resolve => { release = resolve; });
    const loading = createUiStore(api.api);
    const pending = loading.init();
    api.emit({ kind: 'capabilities', route: 'apple-musickit', capabilities: { ...apple, state: 'ready' } });
    release([{ ...apple, state: 'unauthenticated' }]);
    await pending;
    expect(loading.store.getState().capabilities.find(c => c.route === 'apple-musickit')?.state).toBe('ready');
    loading.dispose();
  });
});

describe('event -> state mapping', () => {
  it('applies snapshot events and syncs the clock', () => {
    session.dispatch({ kind: 'snapshot', snapshot: snap({ status: 'paused', positionMs: 5000 }) });
    const s = session.store.getState();
    expect(s.snapshot.status).toBe('paused');
    expect(session.runtime.clock.playing).toBe(false);
    expect(session.runtime.clock.positionMs).toBe(5000);
  });

  it('applies position events to snapshot and runtime clock', () => {
    session.dispatch({ kind: 'position', positionMs: 42_000, atMs: 2000, generationId: 1 });
    expect(session.store.getState().snapshot.positionMs).toBe(42_000);
    expect(session.runtime.clock.positionMs).toBe(42_000);
    expect(session.runtime.clock.atMs).toBe(2000);
  });

  it('applies output events', () => {
    const output = { deviceName: 'DAC', sampleRateHz: 96_000, channels: 2, bitDepth: 24 as const, fidelityBypass: true, exclusive: true };
    session.dispatch({ kind: 'output', output });
    expect(session.store.getState().snapshot.output).toEqual(output);
  });

  it('replaces capability records per route', () => {
    const cap = {
      route: 'local' as const,
      state: 'ready' as const,
      playback: { engine: 'native-pcm' as const, canPlay: true, canPause: true, canSeek: true, canNextPrevious: true, gapless: 'yes' as const, exclusiveOutput: 'no' as const },
      audio: { pcmAccess: 'yes' as const, eq: 'yes' as const, replayGain: 'yes' as const },
      visuals: { kind: 'pcm-fft' as const },
      notes: [],
    };
    session.dispatch({ kind: 'capabilities', route: 'local', capabilities: cap });
    session.dispatch({ kind: 'capabilities', route: 'local', capabilities: { ...cap, state: 'degraded' } });
    const caps = session.store.getState().capabilities;
    expect(caps.filter((c) => c.route === 'local')).toHaveLength(1);
    expect(caps[0]!.state).toBe('degraded');
  });

  it('routes error events to toasts', () => {
    session.dispatch({ kind: 'error', route: 'apple-musickit', message: 'key refused', retriable: false });
    const toasts = session.store.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.route).toBe('apple-musickit');
    expect(toasts[0]!.message).toBe('key refused');
  });
});

describe('stale generation handling', () => {
  it('ignores position events from older generations', () => {
    session.dispatch({ kind: 'snapshot', snapshot: snap({ lease: { generationId: 5, route: 'local', queueId: 'q-a', issuedAtMs: 0 }, positionMs: 100 }) });
    session.dispatch({ kind: 'position', positionMs: 99_999, atMs: 1, generationId: 4 });
    expect(session.store.getState().snapshot.positionMs).toBe(100);
    session.dispatch({ kind: 'position', positionMs: 77_777, atMs: 1, generationId: 5 });
    expect(session.store.getState().snapshot.positionMs).toBe(77_777);
  });

  it('ignores stale fft and trackEnded events', () => {
    session.dispatch({ kind: 'snapshot', snapshot: snap({ lease: { generationId: 5, route: 'local', queueId: 'q-a', issuedAtMs: 0 } }) });
    session.dispatch({ kind: 'fft', bands: [0.9], peak: 0.9, atMs: 1, generationId: 4 });
    expect(session.runtime.fft.atMs).toBe(0);
    session.dispatch({ kind: 'fft', bands: [0.9], peak: 0.9, atMs: 7, generationId: 5 });
    expect(session.runtime.fft.atMs).toBe(7);

    session.dispatch({ kind: 'trackEnded', queueId: 'q-a', generationId: 4 });
    expect(session.store.getState().snapshot.current?.queueId).toBe('q-a');
  });

  it('rejects snapshots carrying an older lease generation', () => {
    session.dispatch({ kind: 'snapshot', snapshot: snap({ lease: { generationId: 5, route: 'local', queueId: 'q-a', issuedAtMs: 0 }, status: 'paused' }) });
    session.dispatch({
      kind: 'snapshot',
      snapshot: snap({ lease: { generationId: 3, route: 'local', queueId: 'q-a', issuedAtMs: 0 }, status: 'playing', positionMs: 42 }),
    });
    expect(session.store.getState().snapshot.status).toBe('paused');
    // lease-less snapshots are always accepted (coordinator stopped state)
    session.dispatch({ kind: 'snapshot', snapshot: snap({ lease: null, status: 'stopped', current: null }) });
    expect(session.store.getState().snapshot.status).toBe('stopped');
  });
});

describe('trackEnded advance', () => {
  it('advances display to the next queue item', () => {
    session.dispatch({ kind: 'trackEnded', queueId: 'q-a', generationId: 1 });
    const s = session.store.getState();
    expect(s.snapshot.current?.queueId).toBe('q-b');
    expect(s.snapshot.status).toBe('loading');
    expect(s.snapshot.positionMs).toBe(0);
  });

  it('stops at the end of the queue when repeat is off', () => {
    session.dispatch({ kind: 'queue', queue: queue([qItem('a'), qItem('b')], { currentIndex: 1 }) });
    session.dispatch({ kind: 'trackEnded', queueId: 'q-b', generationId: 1 });
    expect(session.store.getState().snapshot.status).toBe('stopped');
  });

  it('repeats the track when repeat is one', () => {
    session.dispatch({ kind: 'queue', queue: queue([qItem('a'), qItem('b')], { repeat: 'one' }) });
    session.dispatch({ kind: 'trackEnded', queueId: 'q-a', generationId: 1 });
    expect(session.store.getState().snapshot.current?.queueId).toBe('q-a');
  });

  it('follows shuffle order', () => {
    session.dispatch({
      kind: 'queue',
      queue: queue([qItem('a'), qItem('b'), qItem('c')], { shuffle: true, shuffleOrder: [0, 2, 1], currentIndex: 0 }),
    });
    session.dispatch({ kind: 'trackEnded', queueId: 'q-a', generationId: 1 });
    expect(session.store.getState().snapshot.current?.queueId).toBe('q-c');
  });
});

describe('commands', () => {
  it('sends queue operations', () => {
    session.removeQueueItems(['q-a', 'q-b']);
    session.moveQueueItem(0, 2);
    session.insertNext(track('x'));
    session.playTracks([track('y'), track('z')], 1);
    expect(fake.sent[0]).toEqual({ kind: 'remove', queueIds: ['q-a', 'q-b'] });
    expect(fake.sent[1]).toEqual({ kind: 'move', fromIndex: 0, toIndex: 2 });
    expect(fake.sent[2]!.kind).toBe('insertNext');
    const setQ = fake.sent[3];
    expect(setQ!.kind).toBe('setQueue');
    if (setQ!.kind === 'setQueue') {
      expect(setQ!.items).toHaveLength(2);
      expect(setQ!.startIndex).toBe(1);
      expect(setQ!.autoplay).toBe(true);
    }
  });

  it('seek clamps to duration and updates optimistically', () => {
    session.seek(999_999);
    expect(fake.sent.at(-1)).toEqual({ kind: 'seek', positionMs: 200_000 });
    expect(session.runtime.clock.positionMs).toBe(200_000);
  });

  it('togglePlay maps status to the right command', () => {
    session.togglePlay();
    expect(fake.sent.at(-1)).toEqual({ kind: 'pause' });
    session.dispatch({ kind: 'snapshot', snapshot: snap({ status: 'paused' }) });
    session.togglePlay();
    expect(fake.sent.at(-1)).toEqual({ kind: 'resume' });
  });

  it('togglePlay on a restored session (paused, no lease) sends resume', () => {
    // Restored playback comes back paused without a lease; the transport
    // must resume the coordinator's remembered item, not replay queue[0].
    session.dispatch({ kind: 'snapshot', snapshot: snap({ status: 'paused', lease: null, positionMs: 42_000 }) });
    session.togglePlay();
    expect(fake.sent.at(-1)).toEqual({ kind: 'resume' });
  });

  it('togglePlay on an idle restored queue (stopped, items, nothing selected) sends play', () => {
    // "Play next" additions on an empty queue persist currentIndex -1; after
    // relaunch the queue is populated but nothing is current. The transport
    // must still issue a bare play — the coordinator starts the first item.
    session.dispatch({ kind: 'snapshot', snapshot: snap({ status: 'stopped', lease: null, current: null }) });
    session.dispatch({ kind: 'queue', queue: queue([qItem('a'), qItem('b')], { currentIndex: -1 }) });
    session.togglePlay();
    expect(fake.sent.at(-1)).toEqual({ kind: 'play' });
  });

  it('togglePlay on a paused provider session sends resume', () => {
    session.dispatch({
      kind: 'snapshot',
      snapshot: snap({ status: 'paused', lease: { generationId: 1, route: 'apple-musickit', queueId: 'q-a', issuedAtMs: 0 } }),
    });
    session.togglePlay();
    expect(fake.sent.at(-1)).toEqual({ kind: 'resume' });
  });

  it('insertNext forwards a provider track with its provider source intact', () => {
    const appleTrack: TrackRef = {
      ...track('am-1'),
      route: 'apple-musickit',
      provider: 'apple',
      title: 'Play It Again',
      source: { kind: 'provider', providerItemId: 'am-1' },
    };
    session.insertNext(appleTrack);
    const cmd = fake.sent.at(-1);
    expect(cmd?.kind).toBe('insertNext');
    if (cmd?.kind === 'insertNext') {
      expect(cmd.items[0]!.track.route).toBe('apple-musickit');
      expect(cmd.items[0]!.track.source).toEqual({ kind: 'provider', providerItemId: 'am-1' });
    }
  });

  it('cycleRepeat rotates off -> all -> one', () => {
    session.cycleRepeat();
    expect(fake.sent.at(-1)).toEqual({ kind: 'setRepeat', repeat: 'all' });
    session.dispatch({ kind: 'queue', queue: queue([qItem('a')], { repeat: 'all' }) });
    session.cycleRepeat();
    expect(fake.sent.at(-1)).toEqual({ kind: 'setRepeat', repeat: 'one' });
  });

  it('setFidelityMode sends the fidelity command', () => {
    session.setFidelityMode(true);
    expect(fake.sent.at(-1)).toEqual({ kind: 'setFidelityMode', enabled: true });
    session.setFidelityMode(false);
    expect(fake.sent.at(-1)).toEqual({ kind: 'setFidelityMode', enabled: false });
  });

  it('setEq forwards the band shape to api.audio; devices round-trip', async () => {
    const calls: { freqHz: number; gainDb: number }[][] = [];
    const devices = [{ name: 'DAC', isDefault: true }];
    const picked: (string | null)[] = [];
    fake.api.audio = {
      setEq: async (b) => {
        calls.push(b);
      },
      listDevices: async () => devices,
      setDevice: async (n) => {
        picked.push(n);
      },
    };
    const bands = [
      { freqHz: 60, gainDb: 3 },
      { freqHz: 2400, gainDb: -1.5 },
      { freqHz: 15000, gainDb: 0 },
    ];
    session.setEq(bands);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([bands]);
    session.setEq([]); // Flat
    await new Promise((r) => setTimeout(r, 0));
    expect(calls[1]).toEqual([]);
    expect(await session.listDevices()).toEqual(devices);
    session.setDevice('DAC');
    session.setDevice(null);
    await new Promise((r) => setTimeout(r, 0));
    expect(picked).toEqual(['DAC', null]);
  });

  it('toasts on command rejection', async () => {
    fake.api.sendCommand = async () => {
      throw new Error('boom');
    };
    session.next();
    await new Promise((r) => setTimeout(r, 0));
    expect(session.store.getState().toasts[0]?.message).toBe('boom');
  });
});

describe('queue order helpers', () => {
  it('computes nextQueueIndex across modes', () => {
    const base = queue([qItem('a'), qItem('b')]);
    expect(nextQueueIndex(base)).toBe(1);
    expect(nextQueueIndex(queue(base.items, { currentIndex: 1 }))).toBe(-1);
    expect(nextQueueIndex(queue(base.items, { currentIndex: 1, repeat: 'all' }))).toBe(0);
    expect(nextQueueIndex(queue(base.items, { currentIndex: 0, repeat: 'one' }))).toBe(0);
    expect(nextQueueIndex(queue(base.items, { shuffle: true, shuffleOrder: [1, 0], currentIndex: 1 }))).toBe(0);
  });

  it('displayOrder falls back to base order', () => {
    const items = [qItem('a'), qItem('b'), qItem('c')];
    expect(displayOrder(queue(items))).toEqual([0, 1, 2]);
    expect(displayOrder(queue(items, { shuffle: true, shuffleOrder: [2, 0, 1] }))).toEqual([2, 0, 1]);
  });
});

describe('phone owns playback', () => {
  it('shows the phone in the player, sends transport to it, and returns on playHere', async () => {
    const { MockCadenceApi } = await import('../mock/MockCadenceApi');
    const mock = new MockCadenceApi();
    const s = createUiStore(mock);
    await s.init();
    await mock.remote.setEnabled(true);
    await new Promise((r) => setTimeout(r, 0));
    const before = s.store.getState();
    expect(before.remote?.server.kind).toBe('on');
    const current = before.localSnapshot.current;
    expect(current).not.toBeNull();

    s.playOnDevice('mock-phone');
    await new Promise((r) => setTimeout(r, 10));
    let st = s.store.getState();
    expect(st.remote?.activeOutput?.deviceName).toBe('Pixel 9');
    expect(st.snapshot.status).toBe('playing');
    expect(st.snapshot.current?.queueId).toBe(current?.queueId);
    expect(st.localSnapshot.status).toBe('paused');

    // Pause from the player bar goes to the phone; the computer stays paused.
    s.togglePlay();
    await new Promise((r) => setTimeout(r, 10));
    st = s.store.getState();
    expect(st.remote?.activeOutput?.playing).toBe(false);
    expect(st.snapshot.status).toBe('paused');
    expect(st.localSnapshot.status).toBe('paused');

    s.playHere();
    await new Promise((r) => setTimeout(r, 10));
    st = s.store.getState();
    expect(st.remote?.activeOutput).toBeNull();
    expect(st.snapshot).toBe(st.localSnapshot);
    s.dispose();
    mock.dispose();
  });

  it('refuses to hand off to a phone that is not connected', async () => {
    const { MockCadenceApi } = await import('../mock/MockCadenceApi');
    const mock = new MockCadenceApi();
    const s = createUiStore(mock);
    await s.init();
    await mock.remote.setEnabled(true);
    s.playOnDevice('mock-ipad');
    await new Promise((r) => setTimeout(r, 10));
    const st = s.store.getState();
    expect(st.remote?.activeOutput ?? null).toBeNull();
    expect(st.toasts.at(-1)?.message).toMatch(/not connected/);
    s.dispose();
    mock.dispose();
  });
});
