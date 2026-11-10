import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  CatalogPage,
  CatalogRequest,
  CoordinatorEvent,
  PlaybackCommand,
  PlaybackSnapshot,
  PlatformId,
  QueueItem,
  QueueState,
  RouteCapabilities,
  RouteId,
  ScanProgress,
  TrackRef,
} from '@cadence/protocol';
import type { Rgb } from './palette';
import { DEFAULT_PALETTE } from './palette';
import { cleanIpcError } from './ipcError';
import { providerForRoute } from './routes';

export interface Toast {
  id: number;
  route: RouteId;
  message: string;
  retriable: boolean;
}

export interface EqBand {
  freqHz: number;
  gainDb: number;
}

export interface AudioDevice {
  name: string;
  isDefault: boolean;
}

/** The subset of window.cadence the store needs. CadenceApi satisfies this. */
export interface StoreApiSurface {
  sendCommand(cmd: PlaybackCommand): Promise<unknown>;
  onEvent(cb: (e: CoordinatorEvent) => void): () => void;
  getSnapshot(): Promise<PlaybackSnapshot>;
  getQueue(): Promise<QueueState>;
  getCapabilities(): Promise<RouteCapabilities[]>;
  library: { onScanProgress(cb: (p: ScanProgress) => void): () => void };
  routes?: {
    signIn(route: RouteId): Promise<unknown>;
    signOut(route: RouteId): Promise<unknown>;
  };
  platform?: {
    active(): Promise<PlatformId>;
    setActive(platform: PlatformId): Promise<unknown>;
  };
  catalog?: {
    query(route: RouteId, request: CatalogRequest): Promise<CatalogPage>;
  };
  audio?: {
    setEq(bands: EqBand[]): Promise<unknown>;
    listDevices(): Promise<AudioDevice[]>;
    setDevice(name: string | null): Promise<unknown>;
  };
}

export interface UiState {
  snapshot: PlaybackSnapshot;
  queue: QueueState;
  capabilities: RouteCapabilities[];
  /** Newest lease generation observed; older events are ignored. */
  generationId: number;
  toasts: Toast[];
  scan: ScanProgress;
  /** The active streaming platform ("local" = none). Drives the whole shell. */
  platform: PlatformId;
  nowPlayingExpanded: boolean;
  queueOpen: boolean;
  palette: Rgb[];
  /** Last EQ bands the user applied (engine doesn't report them back). */
  eqBands: EqBand[];
  ready: boolean;
}

/**
 * Frame-rate state that must never re-render React. The Pixi ticker and the
 * seek bar's rAF read this directly; discrete state lives in UiState.
 */
export interface UiRuntime {
  fft: { bands: Float32Array; peak: number; atMs: number; generationId: number };
  clock: { positionMs: number; atMs: number; playing: boolean; durationMs: number };
}

export const EMPTY_QUEUE: QueueState = {
  owner: 'coordinator',
  items: [],
  currentIndex: -1,
  shuffle: false,
  repeat: 'off',
};

export const EMPTY_SNAPSHOT: PlaybackSnapshot = {
  status: 'stopped',
  lease: null,
  current: null,
  positionMs: 0,
  positionAtMs: 0,
  durationMs: 0,
  volume: 0.8,
  muted: false,
};

/** Index of the item that plays next, honoring shuffle order and repeat. */
export function nextQueueIndex(q: QueueState): number {
  const i = q.currentIndex;
  if (q.items.length === 0) return -1;
  if (q.repeat === 'one') return i;
  if (q.shuffle && q.shuffleOrder && q.shuffleOrder.length === q.items.length) {
    const pos = q.shuffleOrder.indexOf(i);
    const np = pos + 1;
    if (np >= q.shuffleOrder.length) return q.repeat === 'all' ? q.shuffleOrder[0]! : -1;
    return q.shuffleOrder[np]!;
  }
  const n = i + 1;
  if (n >= q.items.length) return q.repeat === 'all' ? 0 : -1;
  return n;
}

/** Order in which queue items will actually play (base order unless shuffled). */
export function displayOrder(q: QueueState): number[] {
  if (q.shuffle && q.shuffleOrder && q.shuffleOrder.length === q.items.length) return q.shuffleOrder;
  return q.items.map((_, i) => i);
}

/** A copy of the list in random order (Fisher-Yates). */
export function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

let toastSeq = 0;
let queueSeq = 0;

export function queueItemFor(track: TrackRef, origin?: QueueItem['origin']): QueueItem {
  queueSeq += 1;
  const item: QueueItem = { queueId: `ui-${queueSeq}-${track.id}`, track };
  if (origin) item.origin = origin;
  return item;
}

export interface UiSession {
  store: StoreApi<UiState>;
  runtime: UiRuntime;
  dispatch(e: CoordinatorEvent): void;
  init(): Promise<void>;
  dispose(): void;
  togglePlay(): void;
  next(): void;
  previous(): void;
  seek(positionMs: number): void;
  setVolume(v: number): void;
  toggleMute(): void;
  cycleRepeat(): void;
  toggleShuffle(): void;
  /** Replace the queue with these tracks and start at `startIndex`. */
  playTracks(tracks: TrackRef[], startIndex: number, origin?: QueueItem['origin']): void;
  /** Replace the queue with these tracks in random order and start. */
  playShuffled(tracks: TrackRef[], origin?: QueueItem['origin']): void;
  insertNext(track: TrackRef): void;
  /** Add one or more tracks to the end of the queue, in one command. */
  append(tracks: TrackRef | TrackRef[]): void;
  removeQueueItems(queueIds: string[]): void;
  moveQueueItem(fromIndex: number, toIndex: number): void;
  playQueueId(queueId: string): void;
  signInRoute(route: RouteId): void;
  signOutRoute(route: RouteId): void;
  setPlatform(platform: PlatformId): void;
  setFidelityMode(enabled: boolean): void;
  setReplayGain(enabled: boolean): void;
  setEq(bands: EqBand[]): void;
  listDevices(): Promise<AudioDevice[]>;
  setDevice(name: string | null): void;
  setNowPlayingExpanded(expanded: boolean): void;
  setQueueOpen(open: boolean): void;
  setPalette(p: Rgb[]): void;
  showToast(route: RouteId, message: string, retriable: boolean): void;
  dismissToast(id: number): void;
}

export function createUiStore(api: StoreApiSurface): UiSession {
  const runtime: UiRuntime = {
    fft: { bands: new Float32Array(48), peak: 0, atMs: 0, generationId: -1 },
    clock: { positionMs: 0, atMs: Date.now(), playing: false, durationMs: 0 },
  };

  const store = createStore<UiState>()(() => ({
    snapshot: EMPTY_SNAPSHOT,
    queue: EMPTY_QUEUE,
    capabilities: [],
    generationId: -1,
    toasts: [],
    scan: { phase: 'idle', scanned: 0 },
    platform: 'local',
    eqBands: [],
    nowPlayingExpanded: false,
    queueOpen: false,
    palette: DEFAULT_PALETTE,
    ready: false,
  }));

  const { getState: get, setState: set } = store;

  function pushToast(route: RouteId, message: string, retriable: boolean) {
    const t: Toast = { id: ++toastSeq, route, message, retriable };
    set({ toasts: [...get().toasts.slice(-3), t] });
    setTimeout(() => set({ toasts: get().toasts.filter((x) => x.id !== t.id) }), 6500);
  }

  function syncClock(snap: PlaybackSnapshot) {
    runtime.clock.positionMs = snap.positionMs;
    runtime.clock.atMs = snap.positionAtMs || Date.now();
    runtime.clock.playing = snap.status === 'playing';
    runtime.clock.durationMs = snap.durationMs;
  }

  function advanceDisplay() {
    const { queue, snapshot } = get();
    const ni = nextQueueIndex(queue);
    const item = ni >= 0 ? queue.items[ni] : undefined;
    if (!item || ni === -1) {
      const stopped = { ...snapshot, status: 'stopped' as const, positionMs: 0, positionAtMs: Date.now() };
      set({ snapshot: stopped });
      syncClock(stopped);
      return;
    }
    const advanced: PlaybackSnapshot = {
      ...snapshot,
      status: 'loading',
      current: item,
      positionMs: 0,
      positionAtMs: Date.now(),
      durationMs: item.track.durationMs,
    };
    set({ snapshot: advanced });
    syncClock(advanced);
  }

  function dispatch(e: CoordinatorEvent) {
    const s = get();
    switch (e.kind) {
      case 'snapshot': {
        // Snapshots with an older lease generation are stale too — a dying
        // route must not reclaim playback after a handoff.
        if (e.snapshot.lease && e.snapshot.lease.generationId < s.generationId) break;
        const gen = e.snapshot.lease?.generationId ?? s.generationId;
        set({
          snapshot: e.snapshot,
          generationId: Math.max(gen, s.generationId),
          // Expanded now-playing only exists while a track is loaded. Clearing
          // it here keeps a dropped queue from resurrecting the overlay when
          // the next track starts.
          ...(e.snapshot.current === null ? { nowPlayingExpanded: false } : {}),
        });
        syncClock(e.snapshot);
        break;
      }
      case 'queue':
        set({ queue: e.queue });
        break;
      case 'capabilities': {
        const rest = s.capabilities.filter((c) => c.route !== e.route);
        set({ capabilities: [...rest, e.capabilities] });
        break;
      }
      case 'position': {
        if (e.generationId < s.generationId) break;
        set({ snapshot: { ...s.snapshot, positionMs: e.positionMs, positionAtMs: e.atMs } });
        runtime.clock.positionMs = e.positionMs;
        runtime.clock.atMs = e.atMs;
        break;
      }
      case 'fft': {
        if (e.generationId < s.generationId) break;
        const n = Math.min(e.bands.length, runtime.fft.bands.length);
        for (let i = 0; i < n; i++) runtime.fft.bands[i] = e.bands[i]!;
        runtime.fft.peak = e.peak;
        runtime.fft.atMs = e.atMs;
        runtime.fft.generationId = e.generationId;
        break;
      }
      case 'trackEnded': {
        if (e.generationId < s.generationId) break;
        advanceDisplay();
        break;
      }
      case 'error':
        pushToast(e.route, e.message, e.retriable);
        break;
      case 'output':
        set({ snapshot: { ...s.snapshot, output: e.output } });
        break;
    }
  }

  const cmd = (c: PlaybackCommand) => {
    api.sendCommand(c).catch((err: unknown) => {
      pushToast(get().snapshot.lease?.route ?? 'local', cleanIpcError(err, 'Command failed'), true);
    });
  };

  const unsubs: (() => void)[] = [];
  const session: UiSession = {
    store,
    runtime,
    dispatch,
    async init() {
      // Provider warm-up can authorize while the initial IPC reads are still
      // pending. Subscribe first and keep those newer capability records.
      unsubs.push(api.onEvent(dispatch));
      unsubs.push(api.library.onScanProgress((scan) => set({ scan })));
      const [snapshot, queue, capabilities] = await Promise.all([api.getSnapshot(), api.getQueue(), api.getCapabilities()]);
      const gen = snapshot.lease?.generationId ?? -1;
      const latest = new Map(capabilities.map(cap => [cap.route, cap]));
      for (const cap of get().capabilities) latest.set(cap.route, cap);
      set({ snapshot, queue, capabilities: [...latest.values()], generationId: Math.max(gen, get().generationId), ready: true });
      syncClock(snapshot);
      const platform = await api.platform?.active().catch(() => 'local' as const);
      if (platform) set({ platform });
    },
    dispose() {
      for (const u of unsubs) u();
    },
    togglePlay() {
      const { snapshot, queue } = get();
      if (snapshot.status === 'playing') cmd({ kind: 'pause' });
      else if (snapshot.status === 'paused' || snapshot.status === 'buffering') cmd({ kind: 'resume' });
      else if (snapshot.current) cmd({ kind: 'play', queueId: snapshot.current.queueId });
      else if (queue.items.length) cmd({ kind: 'play' });
    },
    next: () => cmd({ kind: 'next' }),
    previous: () => cmd({ kind: 'previous' }),
    seek(positionMs) {
      const dur = get().snapshot.durationMs;
      const clamped = Math.max(0, Math.min(positionMs, dur || positionMs));
      runtime.clock.positionMs = clamped;
      runtime.clock.atMs = Date.now();
      set({ snapshot: { ...get().snapshot, positionMs: clamped, positionAtMs: runtime.clock.atMs } });
      cmd({ kind: 'seek', positionMs: clamped });
    },
    setVolume(v) {
      const volume = Math.max(0, Math.min(1, v));
      set({ snapshot: { ...get().snapshot, volume, muted: false } });
      cmd({ kind: 'setVolume', volume });
    },
    toggleMute() {
      const muted = !get().snapshot.muted;
      set({ snapshot: { ...get().snapshot, muted } });
      cmd({ kind: 'setMuted', muted });
    },
    cycleRepeat() {
      const order: QueueState['repeat'][] = ['off', 'all', 'one'];
      const cur = get().queue.repeat;
      cmd({ kind: 'setRepeat', repeat: order[(order.indexOf(cur) + 1) % order.length]! });
    },
    toggleShuffle: () => cmd({ kind: 'setShuffle', shuffle: !get().queue.shuffle }),
    playTracks(tracks, startIndex, origin = { kind: 'album' }) {
      if (!tracks.length) return;
      const items = tracks.map((t) => queueItemFor(t, origin));
      cmd({ kind: 'setQueue', items, startIndex, autoplay: true });
    },
    playShuffled: (tracks, origin) => session.playTracks(shuffled(tracks), 0, origin),
    insertNext: (track) => cmd({ kind: 'insertNext', items: [queueItemFor(track, { kind: 'manual' })] }),
    append(tracks) {
      const items = [tracks].flat().map((t) => queueItemFor(t, { kind: 'manual' }));
      if (items.length) cmd({ kind: 'append', items });
    },
    removeQueueItems: (queueIds) => cmd({ kind: 'remove', queueIds }),
    moveQueueItem: (fromIndex, toIndex) => cmd({ kind: 'move', fromIndex, toIndex }),
    playQueueId: (queueId) => cmd({ kind: 'play', queueId }),
    signInRoute(route) {
      if (!api.routes) return;
      void api.routes.signIn(route).catch((e: unknown) => pushToast(route, cleanIpcError(e, 'Sign-in failed'), true));
    },
    signOutRoute(route) {
      if (!api.routes) return;
      void api.routes.signOut(route).then(() => {
        // Signing out of the active platform drops the shell back to local.
        if (get().platform === providerForRoute(route)) set({ platform: 'local' });
      }).catch((e: unknown) => pushToast(route, cleanIpcError(e, 'Sign-out failed'), true));
    },
    setPlatform(platform) {
      set({ platform });
      void api.platform?.setActive(platform).catch(() => undefined);
    },
    setFidelityMode: (enabled) => cmd({ kind: 'setFidelityMode', enabled }),
    setReplayGain: (enabled) => cmd({ kind: 'setReplayGain', enabled }),
    setEq(bands) {
      if (!api.audio) return;
      const route = get().snapshot.lease?.route ?? 'local';
      set({ eqBands: bands });
      void api.audio.setEq(bands).catch(() => pushToast(route, 'Could not apply EQ', true));
    },
    async listDevices() {
      if (!api.audio) return [];
      try {
        return await api.audio.listDevices();
      } catch {
        return [];
      }
    },
    setDevice(name) {
      if (!api.audio) return;
      const route = get().snapshot.lease?.route ?? 'local';
      void api.audio.setDevice(name).catch(() => pushToast(route, 'Could not switch output device', true));
    },
    setNowPlayingExpanded: (expanded) =>
      set({ nowPlayingExpanded: expanded && get().snapshot.current !== null }),
    setQueueOpen: (queueOpen) => set({ queueOpen }),
    setPalette: (palette) => set({ palette }),
    showToast: pushToast,
    dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  };
  return session;
}
