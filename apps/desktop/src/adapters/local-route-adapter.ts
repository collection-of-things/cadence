import type {
  AdapterEvent,
  AudioRpcEvent,
  PlaybackLease,
  PlaybackStatus,
  QueueItem,
  RouteAdapter,
  RouteCapabilities,
  Tri,
} from "@cadence/protocol";
import type { AudioServiceClient } from "../audio/audio-client.js";
import type { FidelityCapable, RestartRestorable } from "./types.js";

/** The item's source could not be expressed to the audio engine. */
export class UnplayableSource extends Error {
  readonly _tag = "UnplayableSource" as const;
  constructor(readonly detail: string) {
    super(detail);
  }
}

/**
 * RouteAdapter for the "local" route: library files decoded by the Rust
 * audio graph via the supervised AudioServiceClient.
 *
 * Capabilities are honest: `gapless` and `exclusiveOutput` start "unknown"
 * and are only upgraded once the engine reports them (event.trackEnded's
 * gapless flag, event.output's exclusive flag).
 */
export class LocalRouteAdapter implements RouteAdapter, RestartRestorable, FidelityCapable {
  readonly route = "local" as const;
  private readonly client: AudioServiceClient;
  private readonly listeners = new Set<(e: AdapterEvent) => void>();
  private lastLoadGeneration = 0;
  private fidelityMode = false;
  private observedGapless = false;
  private observedExclusive: boolean | null = null;

  constructor(client: AudioServiceClient) {
    this.client = client;
    client.onEvent((e) => {
      this.translateEvent(e);
    });
  }

  /** Recompute and return the current honest capability record. */
  async capabilities(): Promise<RouteCapabilities> {
    const state = this.client.clientState;
    const ready = state === "up";
    const gapless: Tri = this.observedGapless ? "yes" : "unknown";
    const exclusive: Tri = this.observedExclusive === null ? "unknown" : this.observedExclusive ? "yes" : "no";
    return {
      route: "local",
      state: ready ? "ready" : state === "failed" ? "error" : "unavailable",
      ...(ready
        ? {}
        : {
            stateDetail:
              state === "failed"
                ? "cadence-audio repeatedly failed to start; check CADENCE_AUDIO_BIN or build services/audio"
                : "cadence-audio is not running yet",
          }),
      playback: {
        engine: "native-pcm",
        canPlay: ready,
        canPause: ready,
        canSeek: ready,
        canNextPrevious: ready,
        gapless,
        exclusiveOutput: exclusive,
      },
      audio: {
        pcmAccess: "yes",
        eq: "yes",
        replayGain: "yes",
        qualityCeiling:
          "Source-native bit depth and rate; fidelity mode bypasses EQ/resample when the device accepts the source format.",
      },
      visuals: { kind: "pcm-fft" },
      notes: [
        "FLAC, WAV, MP3, M4A/ALAC, AAC, OGG and Opus decode inside the Cadence PCM graph.",
        "Gapless depends on prefetch and matching stream formats; reported per-boundary.",
      ],
    };
  }

  /** Ensure the audio service is spawned and answering. Idempotent. */
  async prepare(): Promise<void> {
    await this.client.ensureStarted();
  }

  /** Load and start a queue item under the given lease generation. */
  async play(item: QueueItem, lease: PlaybackLease, opts: { positionMs?: number }): Promise<void> {
    const source = fileSourceOf(item);
    this.lastLoadGeneration = lease.generationId;
    const params: Parameters<AudioServiceClient["load"]>[0] = {
      queueId: item.queueId,
      generationId: lease.generationId,
      source,
    };
    if (opts.positionMs !== undefined) params.positionMs = opts.positionMs;
    if (item.track.replayGainDb !== undefined) params.replayGainDb = item.track.replayGainDb;
    await this.client.load(params);
    if (this.fidelityMode) await this.client.setFidelityMode(true);
  }

  /** Pause under the lease's generation. */
  async pause(lease: PlaybackLease): Promise<void> {
    await this.client.pause(lease.generationId);
  }

  /** Resume under the lease's generation. */
  async resume(lease: PlaybackLease): Promise<void> {
    await this.client.play(lease.generationId);
  }

  /** Confirmed silence: stop both the given lease and our own load generation. */
  async stop(lease: PlaybackLease): Promise<void> {
    const generations = new Set([lease.generationId, this.lastLoadGeneration]);
    let firstError: unknown = null;
    for (const g of generations) {
      try {
        await this.client.stop(g);
      } catch (e) {
        firstError ??= e;
      }
    }
    if (firstError !== null) throw firstError;
  }

  /** Seek under the lease's generation. */
  async seek(lease: PlaybackLease, positionMs: number): Promise<void> {
    await this.client.seek(lease.generationId, positionMs);
  }

  /** Apply engine volume (the coordinator's mute lives above this). */
  async setVolume(volume: number): Promise<void> {
    await this.client.setVolume(volume);
  }

  /** Prefetch a successor file for the gapless boundary. */
  async prefetch(item: QueueItem): Promise<void> {
    if (item.track.source.kind !== "file") return;
    const params: Parameters<AudioServiceClient["prefetch"]>[0] = {
      queueId: item.queueId,
      path: item.track.source.path,
    };
    if (item.track.replayGainDb !== undefined) params.replayGainDb = item.track.replayGainDb;
    await this.client.prefetch(params);
  }

  /** Idle teardown: silence whatever generation is loaded, keep the service warm. */
  async releaseIdle(): Promise<void> {
    if (this.lastLoadGeneration !== 0) {
      await this.client.stop(this.lastLoadGeneration).catch(() => undefined);
    }
  }

  /** Reload the item paused at a position after an engine restart. No autoplay. */
  async restoreAfterEngineRestart(item: QueueItem, positionMs: number): Promise<void> {
    const source = fileSourceOf(item);
    await this.client.load({
      queueId: item.queueId,
      generationId: this.lastLoadGeneration,
      source,
      startPaused: true,
      positionMs,
    });
  }

  /** Toggle strict fidelity mode (EQ/resample bypass) on the engine. */
  async setFidelityMode(enabled: boolean): Promise<void> {
    this.fidelityMode = enabled;
    await this.client.setFidelityMode(enabled);
  }

  /** Tear down the service. */
  async dispose(): Promise<void> {
    await this.client.dispose();
  }

  /** Register the coordinator's adapter-event sink. */
  onEvent(cb: (e: AdapterEvent) => void): void {
    this.listeners.add(cb);
  }

  // --- event translation -----------------------------------------------------

  private emit(e: AdapterEvent): void {
    for (const cb of this.listeners) cb(e);
  }

  private translateEvent(e: AudioRpcEvent): void {
    switch (e.method) {
      case "event.trackStarted": {
        if (e.params.gapless) this.observedGapless = true;
        const started: AdapterEvent = { kind: "started", generationId: e.params.generationId };
        if (e.params.durationMs > 0) this.emit({ ...started, durationMs: e.params.durationMs });
        else this.emit(started);
        return;
      }
      case "event.position": {
        this.emit({
          kind: "position",
          positionMs: e.params.positionMs,
          atMs: e.params.atMs,
          generationId: e.params.generationId,
        });
        return;
      }
      case "event.state": {
        this.emit({
          kind: "state",
          status: mapEngineState(e.params.state),
          generationId: e.params.generationId,
        });
        return;
      }
      case "event.trackEnded": {
        if (e.params.gapless) this.observedGapless = true;
        this.emit({ kind: "ended", generationId: e.params.generationId });
        return;
      }
      case "event.buffering": {
        this.emit({ kind: "state", status: "buffering", generationId: e.params.generationId });
        return;
      }
      case "event.output": {
        this.observedExclusive = e.params.exclusive;
        this.emit({ kind: "capabilitiesChanged" });
        return;
      }
      case "event.error": {
        this.emit({ kind: "error", message: e.params.message, retriable: e.params.retriable });
        return;
      }
      case "event.prefetchReady":
      case "event.fft":
        // fft fans out to the coordinator's graph-event path; prefetchReady
        // is informational for now.
        return;
    }
  }
}

/** Extract the file source or throw UnplayableSource. */
function fileSourceOf(item: QueueItem): { kind: "file"; path: string } {
  const s = item.track.source;
  if (s.kind !== "file") {
    throw new UnplayableSource(
      `local route cannot play source kind "${s.kind}" for "${item.track.title}"`,
    );
  }
  return { kind: "file", path: s.path };
}

function mapEngineState(
  state: "idle" | "loading" | "playing" | "paused" | "stopped" | "error",
): PlaybackStatus {
  switch (state) {
    case "idle":
      return "stopped";
    case "loading":
      return "loading";
    case "playing":
      return "playing";
    case "paused":
      return "paused";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
  }
}
