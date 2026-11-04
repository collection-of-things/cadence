import type {
  AdapterEvent,
  PlaybackLease,
  QueueItem,
  RouteAdapter,
  RouteCapabilities,
  RouteId,
  TrackRef,
} from "@cadence/protocol";

/**
 * Test RouteAdapter: records the call sequence, can be told to fail play(),
 * and exposes an event emitter for the coordinator's adapter-event sink.
 */
export class FakeAdapter implements RouteAdapter {
  readonly calls: string[] = [];
  readonly listeners = new Set<(e: AdapterEvent) => void>();
  failPlay: Error | null = null;
  failPrepare: Error | null = null;
  volumes: number[] = [];
  playedItems: { queueId: string; generationId: number; positionMs?: number }[] = [];

  constructor(readonly route: RouteId) {}

  capabilities(): Promise<RouteCapabilities> {
    return Promise.resolve({
      route: this.route,
      state: "ready",
      playback: {
        engine: "native-pcm",
        canPlay: true,
        canPause: true,
        canSeek: true,
        canNextPrevious: true,
        gapless: "unknown",
        exclusiveOutput: "unknown",
      },
      audio: { pcmAccess: "unknown", eq: "unknown", replayGain: "unknown" },
      visuals: { kind: "ambient" },
      notes: [],
    });
  }

  prepare(): Promise<void> {
    this.calls.push("prepare");
    if (this.failPrepare !== null) return Promise.reject(this.failPrepare);
    return Promise.resolve();
  }

  play(item: QueueItem, lease: PlaybackLease, opts: { positionMs?: number }): Promise<void> {
    this.calls.push(`play:${item.queueId}:g${lease.generationId}`);
    const rec: { queueId: string; generationId: number; positionMs?: number } = {
      queueId: item.queueId,
      generationId: lease.generationId,
    };
    if (opts.positionMs !== undefined) rec.positionMs = opts.positionMs;
    this.playedItems.push(rec);
    if (this.failPlay !== null) return Promise.reject(this.failPlay);
    return Promise.resolve();
  }

  pause(lease: PlaybackLease): Promise<void> {
    this.calls.push(`pause:g${lease.generationId}`);
    return Promise.resolve();
  }

  resume(lease: PlaybackLease): Promise<void> {
    this.calls.push(`resume:g${lease.generationId}`);
    return Promise.resolve();
  }

  stop(lease: PlaybackLease): Promise<void> {
    this.calls.push(`stop:g${lease.generationId}`);
    return Promise.resolve();
  }

  seek(lease: PlaybackLease, positionMs: number): Promise<void> {
    this.calls.push(`seek:g${lease.generationId}:${positionMs}`);
    return Promise.resolve();
  }

  setVolume(volume: number): Promise<void> {
    this.calls.push(`setVolume:${volume}`);
    this.volumes.push(volume);
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    this.calls.push("dispose");
    return Promise.resolve();
  }

  onEvent(cb: (e: AdapterEvent) => void): void {
    this.listeners.add(cb);
  }

  emitAdapterEvent(e: AdapterEvent): void {
    for (const cb of this.listeners) cb(e);
  }
}

/** Build a minimal local-file TrackRef. */
export function fakeTrack(id: string, route: RouteId = "local"): TrackRef {
  return {
    id,
    route,
    provider: route === "local" ? "local" : "spotify",
    title: `Track ${id}`,
    artists: [{ name: "Test Artist" }],
    durationMs: 180_000,
    source: { kind: "file", path: `/music/${id}.flac` },
    availability: "available",
  };
}

/** Build a QueueItem with a caller-chosen queueId (coordinator re-stamps it). */
export function fakeItem(id: string, route: RouteId = "local"): QueueItem {
  return { queueId: `in-${id}`, track: fakeTrack(id, route) };
}
