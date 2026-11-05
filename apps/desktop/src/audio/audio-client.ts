import { execFile, spawn } from "node:child_process";
import { close, createWriteStream, open, unlink } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import type { AudioRpcEvent } from "@cadence/protocol";
import { encodeMessage, parseLine } from "./json-rpc.js";
import type { PcmFormat, PcmStream, PcmStreamSink } from "./pcm-stream.js";

const execFileAsync = promisify(execFile);
const closeAsync = promisify(close);
const unlinkAsync = promisify(unlink);

/** Lifecycle of the supervised audio-service child process. */
export type AudioClientState = "down" | "starting" | "up" | "failed";

/** Minimal child-process surface the client needs (injectable for tests). */
export interface AudioChildProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr?: Readable;
  /** Terminate the child (best-effort SIGTERM). */
  kill(): void;
  /** Subscribe to process exit. */
  on(event: "exit", cb: (code: number | null, signal: string | null) => void): unknown;
  /** Subscribe to spawn errors. */
  on(event: "error", cb: (err: Error) => void): unknown;
}

/** Factory for the child process; defaults to node:child_process.spawn. */
export type SpawnAudio = (binaryPath: string) => AudioChildProcess;

/** The audio service binary could not be resolved or spawned. */
export class AudioBinaryUnavailable extends Error {
  readonly _tag = "AudioBinaryUnavailable" as const;
  constructor(readonly detail: string) {
    super(`cadence-audio unavailable: ${detail}`);
  }
}

/** The service died (or never came up) while requests were in flight. */
export class AudioServiceDown extends Error {
  readonly _tag = "AudioServiceDown" as const;
  constructor(readonly detail: string) {
    super(`cadence-audio down: ${detail}`);
  }
}

/** The service returned a JSON-RPC error for a request. */
export class AudioRpcError extends Error {
  readonly _tag = "AudioRpcError" as const;
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

/** A request exceeded its deadline. */
export class AudioRequestTimeout extends Error {
  readonly _tag = "AudioRequestTimeout" as const;
  constructor(readonly method: string) {
    super(`audio request timed out: ${method}`);
  }
}

/** Restart policy: exponential backoff between bounded bounds. */
export interface RestartPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Give up (state "failed") after this many consecutive failed starts. */
  readonly maxAttempts: number;
}

const DEFAULT_RESTART: RestartPolicy = { baseDelayMs: 250, maxDelayMs: 5_000, maxAttempts: 8 };

/** Constructor dependencies for AudioServiceClient. */
export interface AudioServiceClientDeps {
  /**
   * Path to the cadence-audio binary, or a lazy resolver returning one.
   * null means "not built" — start() fails fast with AudioBinaryUnavailable
   * instead of spawn-looping.
   */
  readonly binaryPath: string | null | (() => string | null);
  readonly spawn?: SpawnAudio;
  readonly requestTimeoutMs?: number;
  readonly restart?: Partial<RestartPolicy>;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Non-JSON stdout lines / stderr text from the service. */
  readonly onLog?: ((line: string) => void) | undefined;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Source shapes for audio.load. The protocol's pcm-stream variant does not
 * name a data path; we extend it with an optional `fifoPath` the service can
 * read directly (posix fast path) and otherwise push chunks via `audio.feed`.
 * DEVIATION (protocol): `fifoPath` on the pcm-stream source and the
 * `audio.feed` method are additive wire extensions pending a protocol update.
 */
type LoadSource =
  | { kind: "file"; path: string }
  | {
      kind: "pcm-stream";
      sampleRateHz: number;
      channels: number;
      bitDepth: number | "float";
      fifoPath?: string;
    };

/**
 * Supervised client for the cadence-audio JSON-RPC service.
 *
 * Responsibilities: spawn + line-delimited JSON-RPC, request correlation and
 * timeouts, crash supervision with bounded exponential backoff, restore of
 * pcm-stream sinks, and raw event fan-out (fft/output/position/trackStarted/
 * trackEnded) to the coordinator's generation gate.
 *
 * On a supervised restart the service comes back empty — callers learn about
 * it through onRestarted and re-load queue intent paused (no autoplay).
 */
export class AudioServiceClient implements PcmStreamSink {
  private readonly binaryPath: string | null | (() => string | null);
  private readonly spawnFn: SpawnAudio;
  private readonly requestTimeoutMs: number;
  private readonly restart: RestartPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onLog: ((line: string) => void) | undefined;

  private proc: AudioChildProcess | null = null;
  private state: AudioClientState = "down";
  private starting: Promise<void> | null = null;
  private intentionalStop = false;
  private disposed = false;
  private attempts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private streamSeq = 0;
  private lineTail = "";
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventListeners = new Set<(e: AudioRpcEvent) => void>();
  private readonly stateListeners = new Set<(s: AudioClientState) => void>();
  private readonly restartedListeners = new Set<() => void>();

  constructor(deps: AudioServiceClientDeps) {
    this.binaryPath = deps.binaryPath;
    this.spawnFn = deps.spawn ?? defaultSpawn;
    this.requestTimeoutMs = deps.requestTimeoutMs ?? 10_000;
    this.restart = { ...DEFAULT_RESTART, ...deps.restart };
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onLog = deps.onLog;
  }

  /** Current lifecycle state. */
  get clientState(): AudioClientState {
    return this.state;
  }

  /** True when the service is spawned and answered ping. */
  isUp(): boolean {
    return this.state === "up";
  }

  /** Subscribe to audio-service events. Returns an unsubscribe function. */
  onEvent(cb: (e: AudioRpcEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => {
      this.eventListeners.delete(cb);
    };
  }

  /** Subscribe to lifecycle transitions. */
  onStateChange(cb: (s: AudioClientState) => void): () => void {
    this.stateListeners.add(cb);
    return () => {
      this.stateListeners.delete(cb);
    };
  }

  /**
   * Fired after a crash-respawn once the service answers ping again. The new
   * process is empty: the coordinator should restore queue intent paused.
   */
  onRestarted(cb: () => void): () => void {
    this.restartedListeners.add(cb);
    return () => {
      this.restartedListeners.delete(cb);
    };
  }

  /** Spawn the service and wait for it to answer ping. Idempotent. */
  async start(): Promise<void> {
    if (this.disposed) throw new AudioServiceDown("client disposed");
    if (this.state === "up") return;
    if (this.starting !== null) return this.starting;
    this.starting = this.boot()
      .catch((e) => {
        this.starting = null;
        throw e;
      })
      .then(() => {
        this.starting = null;
      });
    return this.starting;
  }

  /** Alias used by adapters: ensure the service is running. */
  async ensureStarted(): Promise<void> {
    return this.start();
  }

  // --- typed requests --------------------------------------------------------

  /** Liveness probe. */
  async ping(): Promise<unknown> {
    return this.request("audio.ping", {});
  }

  /** Load a queue item's media; starts playing unless startPaused. */
  async load(params: {
    queueId: string;
    generationId: number;
    source: LoadSource;
    startPaused?: boolean;
    positionMs?: number;
    replayGainDb?: number;
  }): Promise<unknown> {
    return this.request("audio.load", params);
  }

  /** Prefetch the next file for a gapless boundary. */
  /** Drop the installed prefetch (queue edits must cancel stale successors). */
  async clearPrefetch(generationId: number): Promise<unknown> {
    return this.request("audio.clearPrefetch", { generationId });
  }

  async prefetch(params: { queueId: string; path: string; generationId: number; replayGainDb?: number }): Promise<unknown> {
    return this.request("audio.prefetch", params);
  }

  /** Start (or resume) playback under a lease generation. */
  async play(generationId: number): Promise<unknown> {
    return this.request("audio.play", { generationId });
  }

  /** Pause playback under a lease generation. */
  async pause(generationId: number): Promise<unknown> {
    return this.request("audio.pause", { generationId });
  }

  /** Confirmed silence under a lease generation. */
  async stop(generationId: number): Promise<unknown> {
    return this.request("audio.stop", { generationId });
  }

  /** Seek under a lease generation. */
  async seek(generationId: number, positionMs: number): Promise<unknown> {
    return this.request("audio.seek", { generationId, positionMs });
  }

  /** Set output volume 0..1. */
  async setVolume(volume: number): Promise<unknown> {
    return this.request("audio.setVolume", { volume });
  }

  /** Toggle strict fidelity mode (DSP/resample bypass). */
  async setFidelityMode(enabled: boolean): Promise<unknown> {
    return this.request("audio.setFidelityMode", { enabled });
  }

  /** Set the parametric EQ band gains. */
  async setEq(bands: { freqHz: number; gainDb: number }[]): Promise<unknown> {
    return this.request("audio.setEq", { bands });
  }

  /** List available output devices. */
  async listDevices(): Promise<Array<{ name: string; isDefault: boolean }>> {
    // Engine returns { devices: [...] }; the IPC contract is the array.
    const res = (await this.request("audio.listDevices", {})) as
      | { devices?: Array<{ name: string; isDefault: boolean }> }
      | Array<{ name: string; isDefault: boolean }>;
    if (Array.isArray(res)) return res;
    return Array.isArray(res.devices) ? res.devices : [];
  }

  /** Select an output device (null = default). */
  async setDevice(name: string | null): Promise<unknown> {
    return this.request("audio.setDevice", { name });
  }

  /** Ask the service to exit cleanly. */
  async shutdown(): Promise<unknown> {
    return this.request("audio.shutdown", {});
  }

  // --- pcm streams -------------------------------------------------------------

  /**
   * Open a pcm-stream source. Posix fast path: a named fifo the service reads
   * while we write PCM frames. Fallback (and win32): base64 `audio.feed`
   * pushes, one request per chunk so responses provide backpressure.
   */
  async openStream(input: { queueId: string; generationId: number } & PcmFormat): Promise<PcmStream> {
    await this.ensureStarted();
    const sourceBase = {
      kind: "pcm-stream" as const,
      sampleRateHz: input.sampleRateHz,
      channels: input.channels,
      bitDepth: input.bitDepth,
    };
    // The service implements audio.feed only — a fifoPath source would be
    // ignored service-side and silently deadlock, so the fifo fast path is
    // intentionally absent until `fifoPath` lands in the service contract.
    await this.load({
      queueId: input.queueId,
      generationId: input.generationId,
      source: sourceBase,
    });
    return new FeedPcmStream(input.queueId, (params) => this.request("audio.feed", params));
  }

  // --- lifecycle --------------------------------------------------------------

  /** Shut the service down intentionally; no restart, no autoplay. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.intentionalStop = true;
    if (this.restartTimer !== null) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.proc !== null && this.state === "up") {
      try {
        await Promise.race([
          this.shutdown(),
          new Promise((r) => setTimeout(r, 750)),
        ]);
      } catch {
        // best-effort
      }
    }
    this.proc?.kill();
    this.proc = null;
    this.setState("down");
    this.rejectAll(new AudioServiceDown("client disposed"));
  }

  private async boot(): Promise<void> {
    const bin = typeof this.binaryPath === "function" ? this.binaryPath() : this.binaryPath;
    if (bin === null) {
      this.setState("failed");
      throw new AudioBinaryUnavailable(
        "binary not found; set CADENCE_AUDIO_BIN or build services/audio",
      );
    }
    this.attempts = 0;
    this.spawnProc(bin);
    await this.waitUp();
  }

  private spawnProc(bin: string): void {
    this.setState("starting");
    this.lineTail = "";
    let proc: AudioChildProcess;
    try {
      proc = this.spawnFn(bin);
    } catch (e) {
      this.setState("down");
      throw new AudioBinaryUnavailable(`spawn failed: ${String(e)}`);
    }
    this.proc = proc;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      this.feedLines(chunk);
    });
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim() !== "") this.onLog?.(line.trimEnd());
      }
    });
    proc.on("exit", (code, signal) => {
      this.onExit(code, signal);
    });
    proc.on("error", (err) => {
      this.onLog?.(`audio service error: ${err.message}`);
    });
    proc.stdin.on("error", (err) => {
      this.onLog?.(`audio stdin error: ${err.message}`);
      this.rejectAll(new AudioServiceDown(`stdin failed: ${err.message}`));
    });
  }

  private async waitUp(): Promise<void> {
    try {
      await this.ping();
    } catch (e) {
      this.proc?.kill();
      throw e instanceof Error ? e : new AudioServiceDown(String(e));
    }
    this.attempts = 0;
    this.setState("up");
  }

  private onExit(code: number | null, signal: string | null): void {
    this.proc = null;
    const reason = `exit code ${String(code)} signal ${String(signal)}`;
    if (this.intentionalStop || this.disposed) {
      this.setState("down");
      return;
    }
    this.setState("down");
    this.rejectAll(new AudioServiceDown(`service crashed (${reason})`));
    this.attempts += 1;
    if (this.attempts > this.restart.maxAttempts) {
      this.setState("failed");
      this.onLog?.(`audio service gave up after ${this.attempts} attempts (${reason})`);
      return;
    }
    const delay = Math.min(
      this.restart.baseDelayMs * 2 ** (this.attempts - 1),
      this.restart.maxDelayMs,
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.respawn();
    }, delay);
    this.restartTimer.unref?.();
  }

  private async respawn(): Promise<void> {
    if (this.disposed || this.intentionalStop) return;
    const bin = typeof this.binaryPath === "function" ? this.binaryPath() : this.binaryPath;
    if (bin === null) {
      this.setState("failed");
      return;
    }
    try {
      this.spawnProc(bin);
      await this.waitUp();
      for (const cb of this.restartedListeners) cb();
    } catch {
      // Ping/respawn failures get here after waitUp killed the child, whose
      // 'exit' event drives the next backoff step. Only when spawn itself
      // failed (no child, no exit event) do we back off directly.
      if (this.proc === null && this.restartTimer === null && !this.disposed) {
        this.onExit(null, null);
      }
    }
  }

  // --- wire plumbing ------------------------------------------------------------

  private request(method: string, params: unknown): Promise<unknown> {
    const proc = this.proc;
    if (proc === null || this.state === "failed") {
      return Promise.reject(new AudioServiceDown(`cannot send ${method}: service ${this.state}`));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AudioRequestTimeout(method));
      }, this.requestTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      proc.stdin.write(encodeMessage({ jsonrpc: "2.0", id, method, params }), (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new AudioServiceDown(`stdin write failed: ${err.message}`));
        }
      });
    });
  }

  private feedLines(chunk: string): void {
    const lines = (this.lineTail + chunk).split("\n");
    this.lineTail = lines.pop() ?? "";
    for (const line of lines) {
      const msg = parseLine(line);
      switch (msg.kind) {
        case "result": {
          const p = this.pending.get(msg.id);
          if (p !== undefined) {
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            p.resolve(msg.result);
          }
          break;
        }
        case "error": {
          const p = this.pending.get(msg.id);
          if (p !== undefined) {
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            p.reject(new AudioRpcError(msg.code, msg.message));
          }
          break;
        }
        case "event": {
          for (const cb of this.eventListeners) cb(msg.event);
          break;
        }
        case "malformed": {
          this.onLog?.(msg.raw);
          break;
        }
      }
    }
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private setState(s: AudioClientState): void {
    if (this.state === s) return;
    this.state = s;
    for (const cb of this.stateListeners) cb(s);
  }
}

function defaultSpawn(binaryPath: string): AudioChildProcess {
  const child = spawn(binaryPath, [], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    ...(child.stderr !== null ? { stderr: child.stderr } : {}),
    kill: () => {
      child.kill();
    },
    on: (event, cb) => child.on(event, cb),
  };
}

/**
 * pcm-stream over a named fifo. O_RDWR avoids the classic open-for-write
 * block; fs-level writes queue through the pipe's buffer so awaiting write()
 * gives the librespot-style producer natural backpressure.
 */
class FifoPcmStream implements PcmStream {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly writable;

  constructor(
    readonly streamId: string,
    private readonly fifoPath: string,
    private readonly fd: number,
  ) {
    this.writable = createWriteStream(fifoPath, { fd, autoClose: false });
  }

  /** Push one PCM chunk; resolves when the pipe accepts it (backpressure). */
  write(chunk: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new AudioServiceDown("pcm stream closed"));
    const p = this.tail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.writable.write(chunk, (err: Error | null | undefined) => {
            if (err) reject(err);
            else resolve();
          });
        }),
    );
    this.tail = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  /** Signal end-of-stream and release the fifo. */
  async end(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
    this.writable.end();
    await this.closeAndUnlink();
  }

  /** Abort immediately and release the fifo. */
  async abort(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.writable.destroy();
    await this.closeAndUnlink();
  }

  private async closeAndUnlink(): Promise<void> {
    await closeAsync(this.fd).catch(() => undefined);
    await unlinkAsync(this.fifoPath).catch(() => undefined);
  }
}

/**
 * pcm-stream over base64 `audio.feed` requests. Each chunk is a full request
 * so service acks provide backpressure without fifo support (win32, or a
 * service build that cannot open fifos).
 */
class FeedPcmStream implements PcmStream {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(
    readonly streamId: string,
    private readonly feed: (params: { queueId: string; dataBase64?: string; final?: boolean; abort?: boolean }) => Promise<unknown>,
  ) {}

  /** Push one PCM chunk as a base64 audio.feed request; ack = backpressure. */
  write(chunk: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new AudioServiceDown("pcm stream closed"));
    const data = Buffer.from(chunk).toString("base64");
    const p = this.tail.then(() => this.feed({ queueId: this.streamId, dataBase64: data }));
    this.tail = p.then(
      () => undefined,
      () => undefined,
    );
    return p.then(() => undefined);
  }

  /** Signal end-of-stream. */
  async end(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
    await this.feed({ queueId: this.streamId, final: true });
  }

  /** Abort the stream. */
  async abort(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
    await this.feed({ queueId: this.streamId, abort: true });
  }
}
