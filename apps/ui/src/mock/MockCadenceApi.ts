import type {
  ActiveOutput,
  CadenceApi,
  CoordinatorEvent,
  LibraryAlbum,
  LibraryQuery,
  PlaybackCommand,
  PlaybackSnapshot,
  QueueItem,
  QueueState,
  RouteCapabilities,
  RouteId,
  ScanProgress,
  TrackRef,
} from '@cadence/protocol';
import { makeCapabilities, makeLibrary, svgArtwork } from './data';

const FFT_BANDS = 48;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Simulates the whole coordinator session for standalone `vite dev`:
 * queue truth, position clock, FFT for PCM routes, capability records for
 * every route (including unauthenticated providers), library + scan.
 */
export class MockCadenceApi implements CadenceApi {
  private snapshot: PlaybackSnapshot;
  private queue: QueueState;
  private caps: RouteCapabilities[];
  private tracks: TrackRef[];
  private albums: LibraryAlbum[];
  private listeners = new Set<(e: CoordinatorEvent) => void>();
  private scanListeners = new Set<(p: ScanProgress) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private generation = 1;
  private fftPhase = 0;
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Last EQ band set applied via audio.setEq (inspectable in tests). */
  eqBands: { freqHz: number; gainDb: number }[] = [];
  private devices = [
    { name: 'Default Output (PipeWire)', isDefault: true },
    { name: 'SMSL M500 USB DAC', isDefault: false },
    { name: 'HDMI Audio Output', isDefault: false },
  ];

  constructor() {
    const { tracks, albums } = makeLibrary();
    this.tracks = tracks;
    this.albums = albums;
    this.caps = makeCapabilities();

    const initial = [tracks[0]!, tracks[8]!, tracks[9]!, tracks[17]!, tracks[24]!, tracks[31]!, tracks[32]!, tracks[5]!];
    this.queue = {
      owner: 'coordinator',
      items: initial.map((track, i) => ({
        queueId: `q-${i}-${track.id}`,
        track,
        origin: { kind: 'manual' as const },
      })),
      currentIndex: 0,
      shuffle: false,
      repeat: 'off',
    };
    const current = this.queue.items[0]!;
    this.snapshot = {
      status: 'paused',
      lease: { generationId: this.generation, route: current.track.route, queueId: current.queueId, issuedAtMs: Date.now() },
      current,
      positionMs: 47_000,
      positionAtMs: Date.now(),
      durationMs: current.track.durationMs,
      volume: 0.8,
      muted: false,
      output: {
        deviceName: 'Default Output (PipeWire)',
        sampleRateHz: 44_100,
        channels: 2,
        bitDepth: 16,
        fidelityBypass: false,
        exclusive: false,
      },
    };
    this.timer = setInterval(() => this.tick(), 50);
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    for (const t of this.pendingTimers) clearTimeout(t);
  }

  private later(fn: () => void, ms: number) {
    const t = setTimeout(() => {
      this.pendingTimers.delete(t);
      fn();
    }, ms);
    this.pendingTimers.add(t);
  }

  private emit(e: CoordinatorEvent) {
    for (const cb of this.listeners) cb(e);
  }

  private emitSnapshot() {
    this.emit({ kind: 'snapshot', snapshot: clone(this.snapshot) });
  }

  private routeCaps(route: RouteId): RouteCapabilities | undefined {
    return this.caps.find((c) => c.route === route);
  }

  private tick() {
    const s = this.snapshot;
    if (s.status !== 'playing' || !s.lease) return;
    this.fftPhase += 0.05;
    const route = s.lease.route;
    const caps = this.routeCaps(route);
    if (caps?.visuals.kind === 'pcm-fft') {
      const bands: number[] = new Array(FFT_BANDS);
      for (let i = 0; i < FFT_BANDS; i++) {
        const f = i / FFT_BANDS;
        const beat = 0.5 + 0.5 * Math.sin(this.fftPhase * 2.6);
        const v =
          0.18 +
          0.4 * Math.exp(-f * 2.4) * (0.5 + 0.5 * Math.sin(this.fftPhase * 3.1 + i * 0.7)) * beat +
          0.22 * Math.abs(Math.sin(this.fftPhase * 1.3 + i * 1.7)) * (1 - f * 0.6);
        bands[i] = Math.min(1, v);
      }
      this.emit({
        kind: 'fft',
        bands: bands.map((v) => -80 + v * 80), // dBFS like the engine (-80..0)
        peak: Math.max(...bands),
        atMs: Date.now(),
        generationId: s.lease.generationId,
      });
    }
    s.positionMs += 50;
    if (Math.floor(s.positionMs / 500) !== Math.floor((s.positionMs - 50) / 500)) {
      s.positionAtMs = Date.now();
      this.emit({ kind: 'position', positionMs: s.positionMs, atMs: s.positionAtMs, generationId: s.lease.generationId });
    }
    if (s.positionMs >= s.durationMs && s.current) {
      const queueId = s.current.queueId;
      const gen = s.lease.generationId;
      this.emit({ kind: 'trackEnded', queueId, generationId: gen });
      this.advance();
    }
  }

  private advance() {
    const q = this.queue;
    const next = this.nextIndex();
    if (next === -1) {
      this.snapshot.status = 'stopped';
      this.snapshot.positionMs = 0;
      this.emitSnapshot();
      return;
    }
    q.currentIndex = next;
    this.emit({ kind: 'queue', queue: clone(q) });
    this.loadCurrent(true);
  }

  private nextIndex(): number {
    const q = this.queue;
    const i = q.currentIndex;
    if (q.repeat === 'one') return i;
    if (q.shuffle && q.shuffleOrder && q.shuffleOrder.length === q.items.length) {
      const pos = q.shuffleOrder.indexOf(i);
      const np = pos + 1;
      if (np >= q.shuffleOrder.length) return q.repeat === 'all' ? q.shuffleOrder[0]! : -1;
      return q.shuffleOrder[np]!;
    }
    const n = i + 1;
    if (n >= q.items.length) return q.repeat === 'all' && q.items.length ? 0 : -1;
    return n;
  }

  private loadCurrent(autoplay: boolean) {
    const item = this.queue.items[this.queue.currentIndex];
    if (!item) return;
    const caps = this.routeCaps(item.track.route);
    this.generation += 1;
    this.snapshot = {
      ...this.snapshot,
      status: caps && caps.state !== 'ready' && !caps.playback.canPlay ? 'error' : 'loading',
      lease: { generationId: this.generation, route: item.track.route, queueId: item.queueId, issuedAtMs: Date.now() },
      current: clone(item),
      positionMs: 0,
      positionAtMs: Date.now(),
      durationMs: item.track.durationMs,
    };
    if (this.snapshot.status === 'error') {
      this.snapshot.lastError = {
        route: item.track.route,
        queueId: item.queueId,
        message: caps?.stateDetail ?? 'Route is not ready.',
        retriable: false,
      };
      this.emitSnapshot();
      this.emit({ kind: 'error', route: item.track.route, queueId: item.queueId, message: this.snapshot.lastError.message, retriable: false });
      return;
    }
    this.emitSnapshot();
    this.later(() => {
      if (this.snapshot.lease?.generationId !== this.generation) return;
      this.snapshot.status = autoplay ? 'playing' : 'paused';
      this.snapshot.positionAtMs = Date.now();
      this.emitSnapshot();
      const out = this.outputFor(item.track.route);
      this.emit({ kind: 'output', output: out });
    }, 160 + Math.random() * 140);
  }

  private outputFor(route: RouteId): ActiveOutput {
    const base = this.snapshot.output ?? {
      deviceName: 'Default Output (PipeWire)',
      sampleRateHz: 44_100,
      channels: 2,
      bitDepth: 16 as const,
      fidelityBypass: false,
      exclusive: false,
    };
    if (route === 'local') return { ...base, sampleRateHz: 48_000, bitDepth: 'float' };
    if (route === 'spotify-librespot') return { ...base, sampleRateHz: 44_100, bitDepth: 'float' };
    return base;
  }

  async sendCommand(cmd: PlaybackCommand): Promise<void> {
    await Promise.resolve();
    const q = this.queue;
    const s = this.snapshot;
    switch (cmd.kind) {
      case 'setQueue': {
        q.items = clone(cmd.items);
        q.currentIndex = Math.max(0, Math.min(cmd.startIndex ?? 0, q.items.length - 1));
        delete q.shuffleOrder;
        this.emit({ kind: 'queue', queue: clone(q) });
        this.loadCurrent(cmd.autoplay !== false);
        break;
      }
      case 'insertNext': {
        const at = q.currentIndex >= 0 ? q.currentIndex + 1 : 0;
        q.items.splice(at, 0, ...clone(cmd.items));
        this.fixShuffle();
        this.emit({ kind: 'queue', queue: clone(q) });
        break;
      }
      case 'append': {
        q.items.push(...clone(cmd.items));
        this.fixShuffle();
        this.emit({ kind: 'queue', queue: clone(q) });
        break;
      }
      case 'remove': {
        const curId = q.items[q.currentIndex]?.queueId;
        q.items = q.items.filter((it) => !cmd.queueIds.includes(it.queueId));
        q.currentIndex = curId ? q.items.findIndex((it) => it.queueId === curId) : -1;
        this.fixShuffle();
        this.emit({ kind: 'queue', queue: clone(q) });
        break;
      }
      case 'move': {
        const [it] = q.items.splice(cmd.fromIndex, 1);
        if (it) q.items.splice(cmd.toIndex, 0, it);
        const curId = s.current?.queueId;
        if (curId) q.currentIndex = q.items.findIndex((x) => x.queueId === curId);
        this.fixShuffle();
        this.emit({ kind: 'queue', queue: clone(q) });
        break;
      }
      case 'play': {
        if (cmd.queueId) {
          const idx = q.items.findIndex((it) => it.queueId === cmd.queueId);
          if (idx >= 0) {
            q.currentIndex = idx;
            this.emit({ kind: 'queue', queue: clone(q) });
            this.loadCurrent(true);
          }
        } else this.loadCurrent(true);
        break;
      }
      case 'pause':
        if (s.status === 'playing') {
          s.status = 'paused';
          s.positionAtMs = Date.now();
          this.emitSnapshot();
        }
        break;
      case 'resume':
        if (s.status === 'paused') {
          s.status = 'playing';
          s.positionAtMs = Date.now();
          this.emitSnapshot();
        }
        break;
      case 'stop':
        s.status = 'stopped';
        s.positionMs = 0;
        this.emitSnapshot();
        break;
      case 'next':
        this.advance();
        break;
      case 'previous': {
        if (s.positionMs > 3000) {
          s.positionMs = 0;
          s.positionAtMs = Date.now();
          this.emitSnapshot();
          break;
        }
        const prev = q.currentIndex - 1;
        if (prev >= 0) {
          q.currentIndex = prev;
          this.emit({ kind: 'queue', queue: clone(q) });
          this.loadCurrent(true);
        }
        break;
      }
      case 'seek':
        s.positionMs = Math.max(0, Math.min(cmd.positionMs, s.durationMs));
        s.positionAtMs = Date.now();
        if (s.lease) this.emit({ kind: 'position', positionMs: s.positionMs, atMs: s.positionAtMs, generationId: s.lease.generationId });
        break;
      case 'setVolume':
        s.volume = Math.max(0, Math.min(1, cmd.volume));
        this.emitSnapshot();
        break;
      case 'setMuted':
        s.muted = cmd.muted;
        this.emitSnapshot();
        break;
      case 'setRepeat':
        q.repeat = cmd.repeat;
        this.emit({ kind: 'queue', queue: clone(q) });
        break;
      case 'setShuffle': {
        q.shuffle = cmd.shuffle;
        if (q.shuffle) {
          const order = q.items.map((_, i) => i).filter((i) => i !== q.currentIndex);
          for (let i = order.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [order[i], order[j]] = [order[j]!, order[i]!];
          }
          q.shuffleOrder = q.currentIndex >= 0 ? [q.currentIndex, ...order] : order;
        } else {
          delete q.shuffleOrder;
        }
        this.emit({ kind: 'queue', queue: clone(q) });
        break;
      }
      case 'switchRoute': {
        const item = q.items.find((it) => it.queueId === cmd.queueId);
        if (item && this.snapshot.lease) {
          this.snapshot.lease = { ...this.snapshot.lease, route: cmd.route };
          this.emitSnapshot();
        }
        break;
      }
      case 'setFidelityMode': {
        if (s.output) {
          s.output = { ...s.output, fidelityBypass: cmd.enabled };
          this.emit({ kind: 'output', output: clone(s.output) });
        }
        break;
      }
    }
  }

  private fixShuffle() {
    const q = this.queue;
    if (!q.shuffleOrder) return;
    q.shuffleOrder = q.shuffleOrder.filter((i) => i < q.items.length);
  }

  async getSnapshot() {
    return clone(this.snapshot);
  }
  async getQueue() {
    return clone(this.queue);
  }
  async getCapabilities() {
    return clone(this.caps);
  }

  onEvent(cb: (e: CoordinatorEvent) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  library = {
    tracks: async (q?: LibraryQuery): Promise<TrackRef[]> => {
      let out = this.tracks;
      if (q?.text) {
        const t = q.text.toLowerCase();
        out = out.filter(
          (tr) =>
            tr.title.toLowerCase().includes(t) ||
            tr.album?.toLowerCase().includes(t) ||
            tr.artists.some((a) => a.name.toLowerCase().includes(t)),
        );
      }
      if (q?.artist) out = out.filter((tr) => tr.artists.some((a) => a.name === q.artist));
      if (q?.album) out = out.filter((tr) => tr.album === q.album);
      const off = q?.offset ?? 0;
      return clone(out.slice(off, q?.limit ? off + q.limit : undefined));
    },
    albums: async (q?: LibraryQuery): Promise<LibraryAlbum[]> => {
      let out = this.albums;
      if (q?.text) {
        const t = q.text.toLowerCase();
        out = out.filter((a) => a.title.toLowerCase().includes(t) || a.artist.toLowerCase().includes(t));
      }
      return clone(out);
    },
    artists: async (_q?: LibraryQuery) => {
      const map = new Map<string, { name: string; albumCount: number; trackCount: number }>();
      for (const tr of this.tracks) {
        const name = tr.artists[0]?.name ?? 'Unknown Artist';
        const e = map.get(name) ?? { name, albumCount: 0, trackCount: 0 };
        e.trackCount += 1;
        map.set(name, e);
      }
      for (const a of this.albums) {
        const e = map.get(a.artist);
        if (e) e.albumCount += 1;
      }
      return [...map.values()];
    },
    track: async (id: string) => clone(this.tracks.find((t) => t.id === id) ?? null),
    addFoldersAndScan: async () => {
      this.simulateScan();
      return true;
    },
    scan: async () => {
      this.simulateScan();
    },
    onScanProgress: (cb: (p: ScanProgress) => void) => {
      this.scanListeners.add(cb);
      return () => this.scanListeners.delete(cb);
    },
    roots: async () => ['/music', '/music/flac'],
    removeRoots: async (paths: string[]) => ({ removed: paths.length }),
  };

  private simulateScan() {
    const total = 214;
    let n = 0;
    const step = () => {
      n += 30 + Math.floor(Math.random() * 40);
      const done = n >= total;
      const p: ScanProgress = {
        phase: done ? 'watching' : 'scanning',
        scanned: Math.min(n, total),
        total,
      };
      if (!done) p.currentPath = `/music/${Math.floor(Math.random() * 1e4)}.flac`;
      for (const cb of this.scanListeners) cb(clone(p));
      if (!done) this.later(step, 120);
    };
    this.later(step, 150);
  }

  audio = {
    setEq: async (bands: { freqHz: number; gainDb: number }[]) => {
      this.eqBands = clone(bands);
    },
    listDevices: async () => clone(this.devices),
    setDevice: async (name: string | null) => {
      const dev = (name ? this.devices.find((d) => d.name === name) : undefined) ?? this.devices[0]!;
      if (!this.snapshot.output) return;
      this.snapshot.output = { ...this.snapshot.output, deviceName: dev.name };
      this.emit({ kind: 'output', output: clone(this.snapshot.output) });
    },
  };

  /**
   * Provider catalog search. Only youtube-music has a catalog in the mock —
   * matching the real adapters, every other route rejects so the UI's
   * 'search not available' path stays exercised.
   */
  search = {
    provider: async (route: RouteId, text: string): Promise<TrackRef[]> => {
      await new Promise((r) => setTimeout(r, 140));
      if (route !== 'youtube-music') {
        throw new Error(`search is not available for route "${route}"`);
      }
      const cap = this.routeCaps('youtube-music');
      if (cap && cap.state === 'unauthenticated') {
        throw new Error('YouTube Music is not signed in — sign in to search the catalog.');
      }
      const q = text.trim();
      if (!q) return [];
      const seed = [...q].reduce((a, c) => a + c.charCodeAt(0), 0);
      const suffixes = ['(Official Audio)', '— Live Session', '— Remastered'];
      return suffixes.map(
        (s, i): TrackRef => ({
          id: `youtube-music:mock-${q.toLowerCase().replace(/\s+/g, '-')}-${i}`,
          route: 'youtube-music',
          provider: 'youtube',
          title: `${q} ${s}`,
          artists: [{ name: 'Tessellate' }],
          album: 'Slow Machines',
          durationMs: (150 + ((seed + i * 67) % 180)) * 1000,
          artwork: { url: svgArtwork(seed * 31 + i * 97 + 3), width: 600, height: 600 },
          source: { kind: 'provider', providerItemId: `mock-ytm-${seed}-${i}` },
          availability: 'available',
        }),
      );
    },
  };

  routes = {
    signIn: async (route: RouteId) => {
      const c = this.caps.find((x) => x.route === route);
      if (c) {
        c.state = 'ready';
        delete c.stateDetail;
        c.playback.canPlay = c.playback.canPause = c.playback.canSeek = c.playback.canNextPrevious = true;
        this.emit({ kind: 'capabilities', route, capabilities: clone(c) });
      }
    },
    signOut: async (route: RouteId) => {
      const c = this.caps.find((x) => x.route === route);
      if (c) {
        c.state = 'unauthenticated';
        c.stateDetail = 'Signed out.';
        this.emit({ kind: 'capabilities', route, capabilities: clone(c) });
      }
    },
  };


  app = {
    minimize() {},
    toggleMaximize() {},
    close() {},
    platform: 'linux',
    versions: { electron: '0.0.0-mock', chrome: '0.0.0-mock', app: '0.1.0' },
  };
}
