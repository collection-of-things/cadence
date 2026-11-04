/**
 * Spotify route adapter — librespot as a Spotify Connect receiver named
 * "Cadence", with its pipe PCM sink feeding the shared Rust audio graph.
 * Decoded PCM reaches our EQ + FFT — the preferred enhanced route when the
 * account actually plays.
 *
 * Control model (honest): librespot is a Connect *receiver*. Track selection
 * and seek go through the Spotify Web API when a user access token is
 * configured (CADENCE_SPOTIFY_TOKEN / deps.getAccessToken); otherwise the
 * user picks "Cadence" as their Connect device in any Spotify client and we
 * still receive the PCM. Pause/resume stop and start consumption on our
 * side; fifo backpressure naturally pauses librespot's writer.
 *
 * Failure modes stay route-local and are reported distinctly: missing
 * binary, missing credentials, audio-key refusal (upstream), process exit.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync, type ReadStream } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlaybackLease, QueueItem, RouteCapabilities } from "@cadence/protocol";
import { ProviderViewAdapter } from "./provider-adapter-base.js";

/** One writable PCM stream into the shared audio graph. */
export interface PcmStreamLike {
  readonly streamId: string;
  write(chunk: Uint8Array): Promise<void>;
  end(): Promise<void>;
  abort(): Promise<void>;
}

/** The graph surface this adapter needs (satisfied by AudioServiceClient). */
export interface LibrespotGraph {
  openStream(input: {
    queueId: string;
    generationId: number;
    sampleRateHz: number;
    channels: number;
    bitDepth: number | "float";
  }): Promise<PcmStreamLike>;
  play(generationId: number): Promise<unknown>;
  pause(generationId: number): Promise<unknown>;
  stop(generationId: number): Promise<unknown>;
  setVolume(volume: number): Promise<unknown>;
  /** Engine events (position/trackEnded) for the pcm-stream this adapter feeds. */
  onEvent?(cb: (e: { method: string; params: Record<string, unknown> }) => void): () => void;
}

export interface LibrespotAdapterDeps {
  graph: LibrespotGraph;
  /** Path to the librespot binary (env CADENCE_LIBRESPOT_BIN or PATH). */
  binaryPath?: string;
  /** Credentials: username/password or access token for the librespot session. */
  getCredentials?: () => Promise<{ username?: string; password?: string; accessToken?: string } | null>;
  /** User OAuth token for Web API control (device transfer, play, seek). */
  getAccessToken?: () => Promise<string | null>;
  /** Injectable Web API caller for tests. */
  webApi?: (path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>;
}

export class SpotifyLibrespotAdapter extends ProviderViewAdapter {
  readonly route = "spotify-librespot" as const;
  private proc: ChildProcess | null = null;
  private generation = 0;
  private fifoPath: string | null = null;
  private fifoReader: ReadStream | null = null;
  private stream: PcmStreamLike | null = null;
  private deviceId: string | null = null;
  private keyRefused = false;

  constructor(private deps: LibrespotAdapterDeps) {
    super();
    // Engine-side position/trackEnded for the pcm-stream we feed keeps the
    // seek bar and auto-advance alive on this route.
    this.deps.graph.onEvent?.((e) => {
      const generationId = this.generation;
      if (e.method === "event.position") {
        const p = e.params as { positionMs?: number; atMs?: number; generationId?: number };
        if (p.generationId !== generationId || p.positionMs === undefined) return;
        this.emit({ kind: "position", positionMs: p.positionMs, atMs: p.atMs ?? Date.now(), generationId });
      }
      if (e.method === "event.trackEnded") {
        const p = e.params as { generationId?: number };
        if (p.generationId === generationId) this.emit({ kind: "ended", generationId });
      }
      if (e.method === "event.error") {
        const p = e.params as { message?: string; retriable?: boolean };
        this.error(p.message ?? "audio graph error", p.retriable ?? true);
      }
    });
  }

  private binary(): string {
    return this.deps.binaryPath ?? process.env.CADENCE_LIBRESPOT_BIN ?? "librespot";
  }

  private binaryAvailable(): boolean {
    const b = this.binary();
    return b === "librespot" || existsSync(b); // PATH resolution happens in spawn
  }

  async prepare(): Promise<void> {
    if (this.proc || process.platform === "win32") return;
    const creds = await this.deps.getCredentials?.().catch(() => null);
    if (!creds) return; // unauthenticated — report only, spawn on demand
    if (!this.binaryAvailable()) return;

    this.fifoPath = join(tmpdir(), `cadence-librespot-${process.pid}.pcm`);
    await promisify(execFile)("mkfifo", [this.fifoPath]).catch(() => undefined);

    const args = [
      "--name", "Cadence",
      "--backend", "pipe",
      "--device", this.fifoPath,
      "--format", "S16",
      "--bitrate", "320",
      "--disable-audio-cache",
      // Player events -> stdout lines we can read for track state.
      "--verbose",
    ];
    if (creds.accessToken) args.push("--access-token", creds.accessToken);
    else if (creds.username)
      args.push("--username", creds.username, "--password", creds.password ?? "");

    try {
      this.proc = spawn(this.binary(), args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      this.error(`failed to spawn librespot: ${(e as Error).message}`, false);
      this.proc = null;
      return;
    }
    this.keyRefused = false;
    this.proc.on("exit", (code) => {
      this.proc = null;
      if (code !== 0 && code !== null) {
        this.error(`librespot exited (${code})`, true);
      }
      this.emit({ kind: "capabilitiesChanged" });
    });
    this.proc.stderr?.on("data", (d: Buffer) => {
      const line = d.toString();
      if (/audio key|AudioKey|key error/i.test(line)) {
        this.keyRefused = true;
        this.error(
          "Spotify refused the audio key (upstream refusal — login itself succeeded)",
          false,
          "audio-key-refused",
        );
        this.emit({ kind: "capabilitiesChanged" });
      }
      const dev = line.match(/device[_ ]id[:\s]+([0-9a-f]{16,})/i);
      if (dev?.[1]) this.deviceId = dev[1];
    });
    this.proc.stdout?.on("data", (d: Buffer) => {
      // librespot --verbose logs track events on stdout; surface coarse state.
      const line = d.toString();
      if (/<Track|Playing|Loaded/.test(line)) {
        this.emit({ kind: "state", status: "playing", generationId: this.generation });
      }
      if (/Paused/.test(line)) {
        this.emit({ kind: "state", status: "paused", generationId: this.generation });
      }
      if (/Stopped|EndOfTrack|end of track/i.test(line)) {
        this.emit({ kind: "ended", generationId: this.generation });
      }
    });
    this.emit({ kind: "capabilitiesChanged" });
  }

  async capabilities(): Promise<RouteCapabilities> {
    const binaryAvailable = this.binaryAvailable();
    const creds = await this.deps.getCredentials?.().catch(() => null);
    const posix = process.platform !== "win32";
    const state = !posix
      ? "unavailable"
      : !binaryAvailable
        ? "unavailable"
        : !creds
          ? "unauthenticated"
          : this.keyRefused
            ? "degraded"
            : this.proc
              ? "ready"
              : "degraded";
    return this.baseCapabilities({
      route: this.route,
      state,
      stateDetail: !posix
        ? "librespot pipe sink needs a POSIX fifo; Windows feed path is future work."
        : !binaryAvailable
          ? "librespot binary not found (set CADENCE_LIBRESPOT_BIN or install librespot)."
          : !creds
            ? "No Spotify credentials configured."
            : this.keyRefused
              ? "Spotify refused the audio key. The web route is offered as a fallback."
              : "librespot not running yet.",
      playback: {
        engine: binaryAvailable && posix ? "native-pcm" : "none",
        canPlay: binaryAvailable && posix,
        canPause: true,
        canSeek: true,
        canNextPrevious: true,
        gapless: "unknown", // librespot can prefetch; continuity unproven
        exclusiveOutput: "no",
      },
      audio: {
        pcmAccess: binaryAvailable && posix ? "yes" : "unknown",
        eq: binaryAvailable && posix ? "yes" : "unknown",
        replayGain: "yes",
        qualityCeiling: "Ogg Vorbis 320kbps (Premium)",
      },
      visuals: { kind: binaryAvailable && posix ? "pcm-fft" : "ambient" },
      notes: [
        "Premium account required; decoded PCM feeds the shared Rust graph (EQ + real FFT).",
        'Appears as the "Cadence" Connect device; track control uses the Web API when a token is configured.',
        "Login can succeed while the audio key is refused — reported as a distinct failure.",
        "Spotify web player route remains as a fallback.",
      ],
    });
  }

  async play(item: QueueItem, lease: PlaybackLease, opts: { positionMs?: number }): Promise<void> {
    this.generation = lease.generationId;
    await this.prepare();
    if (!this.proc || !this.fifoPath) {
      this.error("librespot is not running (missing binary or credentials)", false);
      throw new Error("librespot unavailable");
    }
    if (item.track.source.kind !== "provider") throw new Error("not a provider track");
    const uri = item.track.source.uri ?? `spotify:track:${item.track.source.providerItemId}`;

    // Open the graph stream first, then start forwarding fifo -> graph.
    this.stream = await this.deps.graph.openStream({
      queueId: item.queueId,
      generationId: lease.generationId,
      sampleRateHz: 44100,
      channels: 2,
      bitDepth: 16,
    });
    this.startForwarding();

    // Ask Spotify to move playback to this Connect device + play the URI.
    const controlled = await this.webApiPlay(uri, opts.positionMs ?? 0);
    if (!controlled) {
      // Honest path: the device exists; the user (or their Spotify client)
      // selects it. Playback still arrives — we just could not initiate it.
      this.emit({
        kind: "error",
        message:
          'No Web API token — select "Cadence" as the Connect device in a Spotify client to start this track.',
        retriable: true,
        code: "connect-manual",
      });
    }
    this.emit({ kind: "started", generationId: lease.generationId, durationMs: item.track.durationMs });
  }

  private startForwarding(): void {
    if (!this.fifoPath || !this.stream) return;
    this.fifoReader?.destroy();
    const rs = createReadStream(this.fifoPath);
    this.fifoReader = rs;
    rs.on("data", (chunk: Buffer) => {
      // Fire-and-forget with backpressure via the stream's own queue.
      this.stream?.write(chunk).catch(() => rs.pause());
    });
    rs.on("error", () => this.error("librespot fifo read failed", true));
    rs.on("end", () => {
      this.emit({ kind: "ended", generationId: this.generation });
    });
  }

  private async webApi(path: string, init?: { method?: string; body?: unknown }): Promise<unknown | null> {
    if (this.deps.webApi) return this.deps.webApi(path, init);
    const token = await this.deps.getAccessToken?.().catch(() => null);
    if (!token) return null;
    const res = await fetch(`https://api.spotify.com/v1${path}`, {
      method: init?.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!res.ok && res.status !== 204) throw new Error(`spotify web api ${res.status}`);
    return res.status === 204 ? null : res.json().catch(() => null);
  }

  private async webApiPlay(uri: string, positionMs: number): Promise<boolean> {
    try {
      const devices = (await this.webApi("/me/player/devices")) as {
        devices?: { id: string; name: string }[];
      } | null;
      const me = devices?.devices?.find((d) => d.name === "Cadence") ?? devices?.devices?.[0];
      if (!me) return false;
      this.deviceId = me.id;
      await this.webApi("/me/player", { method: "PUT", body: { device_ids: [me.id], play: false } });
      await this.webApi("/me/player/play", {
        method: "PUT",
        body: { uris: [uri], position_ms: positionMs },
      });
      return true;
    } catch {
      return false;
    }
  }

  async pause(lease: PlaybackLease): Promise<void> {
    if (lease.generationId !== this.generation) return;
    this.fifoReader?.pause();
    await this.deps.graph.pause(lease.generationId).catch(() => {});
  }

  async resume(lease: PlaybackLease): Promise<void> {
    if (lease.generationId !== this.generation) return;
    await this.deps.graph.play(lease.generationId).catch(() => {});
    this.fifoReader?.resume();
  }

  async stop(lease: PlaybackLease): Promise<void> {
    if (lease.generationId !== this.generation) return;
    this.fifoReader?.destroy();
    this.fifoReader = null;
    await this.stream?.end().catch(() => {});
    this.stream = null;
    await this.deps.graph.stop(lease.generationId).catch(() => {});
    await this.webApi("/me/player/pause", { method: "PUT" }).catch(() => {});
  }

  async seek(lease: PlaybackLease, positionMs: number): Promise<void> {
    if (lease.generationId !== this.generation) return;
    try {
      await this.webApi(`/me/player/seek?position_ms=${Math.round(positionMs)}`, { method: "PUT" });
    } catch {
      this.error("seek failed: no Web API token configured", true, "seek-unavailable");
    }
  }

  async setVolume(volume: number): Promise<void> {
    await this.deps.graph.setVolume(volume).catch(() => {});
  }

  async dispose(): Promise<void> {
    this.fifoReader?.destroy();
    this.fifoReader = null;
    await this.stream?.abort().catch(() => {});
    this.stream = null;
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }
}
