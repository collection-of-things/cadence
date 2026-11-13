import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { extname } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  REMOTE_COMMAND_KINDS,
  REMOTE_PROTOCOL_VERSION,
  buildPairLink,
  remoteArtworkPath,
  type CoordinatorEvent,
  type PlaybackCommand,
  type PlaybackSnapshot,
  type QueueItem,
  type QueueState,
  type RemoteActiveOutput,
  type RemoteCommand,
  type RemoteForwardedEvent,
  type RemoteHostInfo,
  type RemoteOutputReport,
  type RemotePairResponse,
  type RemotePairing,
  type RemotePhoneCommand,
  type RemoteServerMessage,
  type RemoteServerState,
  type RemoteStatus,
} from "@cadence/protocol";
import { parsePlaybackCommand } from "../ipc-validation.js";
import { isOk } from "../result.js";
import type { RemoteDevices } from "./remote-devices.js";

/** The coordinator surface the LAN server needs. */
export interface RemoteCoordinator {
  onEvent(cb: (e: CoordinatorEvent) => void): () => void;
  getSnapshot(): PlaybackSnapshot;
  getQueue(): QueueState;
  handleCommand(cmd: PlaybackCommand): Promise<void>;
}

export interface RemoteServiceDeps {
  readonly devices: RemoteDevices;
  readonly coordinator: RemoteCoordinator;
  /** Absolute path of a local library track's audio file, or null. */
  readonly mediaFile: (trackId: string) => string | null;
  /** Absolute path of a local library track's cached cover, or null. */
  readonly artworkFile: (trackId: string) => string | null;
  readonly hostName: string;
  readonly appVersion: string;
  /** Render text as a QR code SVG document. */
  readonly renderQr: (text: string) => Promise<string>;
  /** LAN addresses to advertise; defaults to the machine's private IPv4 addresses. */
  readonly listAddresses?: () => string[];
  /** Bind address; tests pass 127.0.0.1. */
  readonly bindHost?: string;
  /** Announce the server on the LAN (mDNS) while it runs. Returns a stop function. */
  readonly advertise?: (service: { port: number; hostId: string; name: string }) => () => void;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

const MAX_BODY_BYTES = 4096;
const HEARTBEAT_MS = 15_000;
/** How often to re-read the machine's addresses (Wi-Fi changes, VPN up/down). */
const ADDRESS_REFRESH_MS = 10_000;
/** How long the computer waits for a reclaimed track to start before seeking. */
const RECLAIM_START_TIMEOUT_MS = 8_000;
/** How long reports from a phone told to stop are ignored while it winds down. */
const STOPPING_GRACE_MS = 5_000;

/** Transport kinds that go to the phone while it owns playback. */
const PHONE_ROUTED: ReadonlySet<PlaybackCommand["kind"]> = new Set([
  "play",
  "pause",
  "resume",
  "stop",
  "next",
  "previous",
  "seek",
  "setVolume",
]);

function finite(u: unknown): u is number {
  return typeof u === "number" && Number.isFinite(u);
}

/** Validate a phone's output report. */
export function parseOutputReport(u: unknown): RemoteOutputReport | null {
  if (typeof u !== "object" || u === null) return null;
  const o = u as Record<string, unknown>;
  if (typeof o.queueId !== "string" || o.queueId.length === 0 || typeof o.playing !== "boolean") return null;
  if (!finite(o.positionMs) || !finite(o.durationMs) || !finite(o.volume)) return null;
  return {
    queueId: o.queueId,
    playing: o.playing,
    positionMs: Math.max(0, o.positionMs),
    durationMs: Math.max(0, o.durationMs),
    volume: Math.min(1, Math.max(0, o.volume)),
  };
}

/** Where the phone is now, projected from its last report. */
export function projectOutputPosition(o: RemoteActiveOutput, now: number): number {
  const pos = o.positionMs + (o.playing ? Math.max(0, now - o.reportedAtMs) : 0);
  return o.durationMs > 0 ? Math.min(pos, o.durationMs) : pos;
}

/** Map a desktop transport command to the phone's command set. Null when it has no phone meaning. */
function toPhoneCommand(cmd: PlaybackCommand): RemotePhoneCommand | null {
  switch (cmd.kind) {
    case "play":
      // A bare "play" on a paused phone session means resume.
      return cmd.queueId === undefined ? { kind: "resume" } : { kind: "play", queueId: cmd.queueId };
    case "pause":
    case "resume":
    case "stop":
    case "next":
    case "previous":
      return { kind: cmd.kind };
    case "seek":
      return { kind: "seek", positionMs: cmd.positionMs };
    case "setVolume":
      return { kind: "setVolume", volume: Math.min(1, Math.max(0, cmd.volume)) };
    default:
      return null;
  }
}

const AUDIO_TYPES: Readonly<Record<string, string>> = {
  ".flac": "audio/flac",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".aac": "audio/aac",
  ".alac": "audio/mp4",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
};

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/** Private, non-loopback IPv4 addresses, most likely home-network first. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal || a.address.startsWith("169.254.")) continue;
      out.push(a.address);
    }
  }
  const rank = (ip: string): number =>
    ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
  return [...new Set(out)].sort((a, b) => rank(a) - rank(b));
}

export type ByteRange = { start: number; end: number };

/**
 * Parse a single-range `Range` header against a file size. Returns null for
 * no header, "unsatisfiable" for a range outside the file, or the inclusive
 * byte span. Multi-range requests are served as the whole file.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | null | "unsatisfiable" {
  if (header === undefined) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (m === null) return null;
  const [, a = "", b = ""] = m;
  if (a === "" && b === "") return null;
  if (a === "") {
    const suffix = Number(b);
    if (suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(a);
  const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

/** Point local cover art at the LAN server; other artwork URLs pass through. */
function shareItem(item: QueueItem): QueueItem {
  const art = item.track.artwork;
  if (art === undefined || !art.url.startsWith("cadence-art:")) return item;
  return { ...item, track: { ...item.track, artwork: { ...art, url: remoteArtworkPath(item.track.id) } } };
}

function shareSnapshot(s: PlaybackSnapshot): PlaybackSnapshot {
  return s.current === null ? s : { ...s, current: shareItem(s.current) };
}

function shareQueue(q: QueueState): QueueState {
  return { ...q, items: q.items.map(shareItem) };
}

function shareEvent(e: RemoteForwardedEvent): RemoteForwardedEvent {
  switch (e.kind) {
    case "snapshot":
      return { kind: "snapshot", snapshot: shareSnapshot(e.snapshot) };
    case "queue":
      return { kind: "queue", queue: shareQueue(e.queue) };
    default:
      return e;
  }
}

function isRemoteCommand(cmd: PlaybackCommand): cmd is RemoteCommand {
  return (REMOTE_COMMAND_KINDS as ReadonlySet<string>).has(cmd.kind);
}

function bearer(req: IncomingMessage, url: URL): string {
  const h = req.headers.authorization;
  if (typeof h === "string" && h.startsWith("Bearer ")) return h.slice(7).trim();
  return url.searchParams.get("t") ?? "";
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * The desktop side of phone sync: a LAN HTTP + WebSocket server that lets
 * paired phones follow and control playback, and stream local library files.
 * Off by default; the listener only exists while the user has it enabled.
 */
export class RemoteService {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private state: RemoteServerState = { kind: "off" };
  private pairing: RemotePairing | null = null;
  private pairingTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly sockets = new Map<WebSocket, { deviceId: string; alive: boolean }>();
  private readonly listeners = new Set<(s: RemoteStatus) => void>();
  private unsubCoordinator: (() => void) | null = null;
  private stopAdvertising: (() => void) | null = null;
  private addressTimer: ReturnType<typeof setInterval> | null = null;
  private activeOutput: RemoteActiveOutput | null = null;
  /** True while playback moves back to the computer, so its own start is not read as a takeover. */
  private reclaiming = false;
  /** Phones told to stop, until when. Reports already in flight must not re-take ownership. */
  private readonly stopping = new Map<string, number>();
  /** The computer's last playback status, to spot it starting again. */
  private lastLocalStatus: PlaybackSnapshot["status"] | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: RemoteServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  status(): RemoteStatus {
    const online = new Set([...this.sockets.values()].map((s) => s.deviceId));
    return {
      enabled: this.deps.devices.enabled,
      server: this.state,
      devices: this.deps.devices.list(online),
      pairing: this.pairing,
      activeOutput: this.activeOutput,
    };
  }

  /**
   * While a phone owns playback, send desktop transport (player bar, media
   * keys) to it instead of the local engine. Returns true when the command
   * was routed to the phone.
   */
  routeCommand(cmd: PlaybackCommand): boolean {
    const active = this.activeOutput;
    if (active === null || !PHONE_ROUTED.has(cmd.kind)) return false;
    const phoneCmd = toPhoneCommand(cmd);
    if (phoneCmd === null || !this.sendToDevice(active.deviceId, { kind: "control", command: phoneCmd, serverNowMs: this.now() })) {
      return false;
    }
    // Reflect the obvious result at once; the phone's next report confirms it.
    if (phoneCmd.kind === "pause" || phoneCmd.kind === "resume") {
      this.activeOutput = {
        ...active,
        playing: phoneCmd.kind === "resume",
        positionMs: projectOutputPosition(active, this.now()),
        reportedAtMs: this.now(),
      };
      this.emitStatus();
    } else if (phoneCmd.kind === "seek") {
      this.activeOutput = { ...active, positionMs: phoneCmd.positionMs, reportedAtMs: this.now() };
      this.emitStatus();
    }
    return true;
  }

  /** Ask an online phone to take over where the computer is. */
  handoff(deviceId: string): RemoteStatus {
    const snap = this.deps.coordinator.getSnapshot();
    const current = snap.current;
    if (current === null) throw new Error("Nothing is playing to move to the phone.");
    if (!this.isOnline(deviceId)) throw new Error("That phone is not connected. Open Cadence on it first.");
    const elapsed = snap.status === "playing" ? Math.max(0, this.now() - snap.positionAtMs) : 0;
    const positionMs = snap.durationMs > 0 ? Math.min(snap.positionMs + elapsed, snap.durationMs) : snap.positionMs + elapsed;
    this.stopping.delete(deviceId);
    this.sendToDevice(deviceId, { kind: "handoff", queueId: current.queueId, positionMs, serverNowMs: this.now() });
    return this.status();
  }

  /** Move playback from the phone back to the computer at the phone's position. */
  async reclaim(): Promise<RemoteStatus> {
    const active = this.activeOutput;
    if (active === null) return this.status();
    const positionMs = projectOutputPosition(active, this.now());
    this.reclaiming = true;
    try {
      this.stopPhone(active.deviceId);
      this.setActiveOutput(null);
      const started = this.waitForLocalStart(active.queueId);
      await this.deps.coordinator.handleCommand({ kind: "play", queueId: active.queueId });
      if ((await started) && positionMs > 1000) {
        await this.deps.coordinator.handleCommand({ kind: "seek", positionMs });
      }
    } finally {
      this.reclaiming = false;
    }
    return this.status();
  }

  onStatus(cb: (s: RemoteStatus) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Start the listener if the user left sync enabled last time. */
  async startIfEnabled(): Promise<void> {
    if (this.deps.devices.enabled) await this.start();
  }

  async setEnabled(enabled: boolean): Promise<RemoteStatus> {
    this.deps.devices.setEnabled(enabled);
    if (enabled) await this.start();
    else await this.stop();
    return this.status();
  }

  /** Open a pairing window and render its QR code. Requires the server to be on. */
  async startPairing(): Promise<RemoteStatus> {
    if (this.state.kind !== "on") throw new Error("Turn on phone sync before pairing.");
    const { code, expiresAtMs } = this.deps.devices.openPairing();
    const link = buildPairLink({
      hosts: this.state.addresses,
      port: this.state.port,
      code,
      name: this.deps.hostName,
    });
    const qrSvg = await this.deps.renderQr(link);
    this.pairing = { code, expiresAtMs, link, qrSvg };
    this.armPairingExpiry(expiresAtMs);
    this.emitStatus();
    return this.status();
  }

  cancelPairing(): RemoteStatus {
    this.deps.devices.closePairing();
    this.clearPairing();
    this.emitStatus();
    return this.status();
  }

  revoke(deviceId: string): RemoteStatus {
    this.deps.devices.revoke(deviceId);
    for (const [ws, info] of this.sockets) {
      if (info.deviceId === deviceId) ws.close(4001, "device removed");
    }
    this.emitStatus();
    return this.status();
  }

  async dispose(): Promise<void> {
    this.listeners.clear();
    await this.stop();
  }

  // --- lifecycle ---------------------------------------------------------------------

  private async start(): Promise<void> {
    if (this.server !== null) return;
    this.state = { kind: "starting" };
    this.emitStatus();
    const server = createServer((req, res) => {
      void this.handleHttp(req, res);
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    server.on("upgrade", (req, socket, head) => this.handleUpgrade(wss, req, socket, head));
    try {
      const port = await this.listen(server, this.deps.devices.port).catch(async (e: unknown) => {
        // The saved port is taken by something else: let the OS pick one and
        // remember it, so paired phones find the same port next launch.
        if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
        return this.listen(server, 0);
      });
      if (port !== this.deps.devices.port) this.deps.devices.setPort(port);
      this.server = server;
      this.wss = wss;
      const addresses = (this.deps.listAddresses ?? lanAddresses)();
      this.state = { kind: "on", port, addresses };
      this.lastLocalStatus = this.deps.coordinator.getSnapshot().status;
      this.unsubCoordinator = this.deps.coordinator.onEvent((e) => this.forward(e));
      this.heartbeat = setInterval(() => this.checkHeartbeats(), HEARTBEAT_MS);
      this.addressTimer = setInterval(() => void this.refreshAddresses(), ADDRESS_REFRESH_MS);
      try {
        this.stopAdvertising =
          this.deps.advertise?.({ port, hostId: this.deps.devices.hostId, name: this.deps.hostName }) ?? null;
      } catch (e) {
        // Discovery is a convenience; typed addresses and the QR code still work.
        this.deps.log?.(`mDNS announce failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.deps.log?.(`phone sync listening on port ${port} (${addresses.join(", ") || "no LAN address"})`);
    } catch (e) {
      server.close();
      wss.close();
      this.state = { kind: "error", message: e instanceof Error ? e.message : String(e) };
    }
    this.emitStatus();
  }

  private listen(server: Server, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (e: Error): void => {
        server.off("listening", onListening);
        reject(e);
      };
      const onListening = (): void => {
        server.off("error", onError);
        const addr = server.address();
        resolve(typeof addr === "object" && addr !== null ? addr.port : port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, this.deps.bindHost ?? "0.0.0.0");
    });
  }

  private async stop(): Promise<void> {
    this.unsubCoordinator?.();
    this.unsubCoordinator = null;
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.addressTimer !== null) clearInterval(this.addressTimer);
    this.addressTimer = null;
    this.stopAdvertising?.();
    this.stopAdvertising = null;
    this.activeOutput = null;
    this.deps.devices.closePairing();
    this.clearPairing();
    for (const ws of this.sockets.keys()) ws.terminate();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    this.wss?.close();
    this.wss = null;
    if (server !== null) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.state = { kind: "off" };
    this.emitStatus();
  }

  // --- HTTP ----------------------------------------------------------------------------

  private hostInfo(): RemoteHostInfo {
    return {
      app: "cadence",
      protocol: REMOTE_PROTOCOL_VERSION,
      hostId: this.deps.devices.hostId,
      name: this.deps.hostName,
      version: this.deps.appVersion,
    };
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://cadence.local");
      const path = url.pathname;
      if (req.method === "GET" && path === "/v1/info") {
        sendJson(res, 200, this.hostInfo());
        return;
      }
      if (req.method === "POST" && path === "/v1/pair") {
        await this.handlePair(req, res);
        return;
      }
      const media = /^\/v1\/(media|artwork)\/([^/]+)$/.exec(path);
      if (media !== null && (req.method === "GET" || req.method === "HEAD")) {
        const device = this.deps.devices.authenticate(bearer(req, url));
        if (device === null) {
          sendJson(res, 401, { error: "not paired" });
          return;
        }
        const trackId = decodeURIComponent(media[2] ?? "");
        if (media[1] === "media") await this.serveMedia(req, res, trackId);
        else await this.serveArtwork(res, trackId);
        return;
      }
      sendJson(res, 404, { error: "not found" });
    } catch (e) {
      this.deps.log?.(`phone sync request failed: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) sendJson(res, 500, { error: "server error" });
      else res.destroy();
    }
  }

  private async handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { error: "expected a JSON body" });
      return;
    }
    const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    if (typeof b.code !== "string" || typeof b.deviceName !== "string") {
      sendJson(res, 400, { error: "code and deviceName are required" });
      return;
    }
    const result = this.deps.devices.pair(b.code, b.deviceName);
    switch (result.kind) {
      case "no-pairing":
        sendJson(res, 403, { error: "Pairing is not open. Click Pair a phone on the computer." });
        return;
      case "wrong-code":
        if (result.attemptsLeft === 0) {
          this.clearPairing();
          this.emitStatus();
        }
        sendJson(res, 403, {
          error:
            result.attemptsLeft > 0
              ? `Wrong code. ${result.attemptsLeft} tries left.`
              : "Too many wrong codes. Start pairing again on the computer.",
        });
        return;
      case "paired": {
        this.clearPairing();
        this.emitStatus();
        const response: RemotePairResponse = {
          token: result.token,
          deviceId: result.device.id,
          host: this.hostInfo(),
        };
        sendJson(res, 200, response);
        return;
      }
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }

  private async serveMedia(req: IncomingMessage, res: ServerResponse, trackId: string): Promise<void> {
    const path = this.deps.mediaFile(trackId);
    if (path === null) {
      sendJson(res, 404, { error: "not a local library track" });
      return;
    }
    const info = await stat(path).catch(() => null);
    if (info === null || !info.isFile()) {
      sendJson(res, 404, { error: "file missing" });
      return;
    }
    const size = info.size;
    const type = AUDIO_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
    const range = parseRange(typeof req.headers.range === "string" ? req.headers.range : undefined, size);
    if (range === "unsatisfiable") {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    res.writeHead(range === null ? 200 : 206, {
      "Content-Type": type,
      "Content-Length": size === 0 ? 0 : end - start + 1,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
      ...(range === null ? {} : { "Content-Range": `bytes ${start}-${end}/${size}` }),
    });
    if (req.method === "HEAD" || size === 0) {
      res.end();
      return;
    }
    const stream = createReadStream(path, { start, end });
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  }

  private async serveArtwork(res: ServerResponse, trackId: string): Promise<void> {
    const path = this.deps.artworkFile(trackId);
    const info = path === null ? null : await stat(path).catch(() => null);
    if (path === null || info === null || !info.isFile()) {
      sendJson(res, 404, { error: "no artwork" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": IMAGE_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": "private, max-age=86400",
    });
    const stream = createReadStream(path);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }

  // --- WebSocket -----------------------------------------------------------------------

  private handleUpgrade(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://cadence.local");
    if (url.pathname !== "/v1/live") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const device = this.deps.devices.authenticate(bearer(req, url));
    if (device === null) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, device.id));
  }

  private attach(ws: WebSocket, deviceId: string): void {
    this.sockets.set(ws, { deviceId, alive: true });
    this.deps.devices.touch(deviceId);
    ws.on("pong", () => {
      const info = this.sockets.get(ws);
      if (info !== undefined) info.alive = true;
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      void this.onClientMessage(ws, deviceId, String(data));
    });
    ws.on("close", () => {
      this.sockets.delete(ws);
      this.deps.devices.touch(deviceId);
      if (!this.isOnline(deviceId)) this.stopping.delete(deviceId);
      // A phone that vanished mid-session no longer owns playback here.
      if (this.activeOutput?.deviceId === deviceId && !this.isOnline(deviceId)) this.setActiveOutput(null);
      this.emitStatus();
    });
    ws.on("error", () => ws.terminate());
    this.send(ws, {
      kind: "hello",
      host: this.hostInfo(),
      deviceId,
      snapshot: shareSnapshot(this.deps.coordinator.getSnapshot()),
      queue: shareQueue(this.deps.coordinator.getQueue()),
      serverNowMs: this.now(),
    });
    this.send(ws, { kind: "session", activeDeviceId: this.activeOutput?.deviceId ?? null, serverNowMs: this.now() });
    this.emitStatus();
  }

  private async onClientMessage(ws: WebSocket, deviceId: string, text: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      this.sendError(ws, "messages must be JSON");
      return;
    }
    const m = typeof msg === "object" && msg !== null ? (msg as Record<string, unknown>) : {};
    if (m.kind === "ping") return;
    if (m.kind === "output") {
      const report = parseOutputReport(m.output);
      if (report === null) {
        this.sendError(ws, "output report is malformed");
        return;
      }
      this.onOutputReport(deviceId, report);
      return;
    }
    if (m.kind === "release") {
      this.stopping.delete(deviceId);
      if (this.activeOutput?.deviceId === deviceId) this.setActiveOutput(null);
      return;
    }
    if (m.kind !== "command") {
      this.sendError(ws, "unknown message kind");
      return;
    }
    const parsed = parsePlaybackCommand(m.command);
    if (!isOk(parsed)) {
      this.sendError(ws, parsed.error.detail);
      return;
    }
    if (!isRemoteCommand(parsed.value)) {
      this.sendError(ws, `"${parsed.value.kind}" is not allowed from a phone`);
      return;
    }
    this.deps.devices.touch(deviceId);
    try {
      await this.deps.coordinator.handleCommand(parsed.value);
    } catch (e) {
      this.sendError(ws, e instanceof Error ? e.message : String(e));
    }
  }

  private forward(e: CoordinatorEvent): void {
    // The computer started playing on its own (someone pressed play there):
    // it owns playback again, so the phone stops.
    const wasStatus = this.lastLocalStatus;
    if (e.kind === "snapshot") this.lastLocalStatus = e.snapshot.status;
    if (
      e.kind === "snapshot" &&
      e.snapshot.status === "playing" &&
      wasStatus !== "playing" &&
      this.activeOutput !== null &&
      !this.reclaiming
    ) {
      this.stopPhone(this.activeOutput.deviceId);
      this.setActiveOutput(null);
    }
    if (e.kind === "fft" || this.sockets.size === 0) return;
    const msg: RemoteServerMessage = { kind: "event", event: shareEvent(e), serverNowMs: this.now() };
    const text = JSON.stringify(msg);
    for (const ws of this.sockets.keys()) {
      if (ws.readyState === ws.OPEN) ws.send(text);
    }
  }

  private send(ws: WebSocket, msg: RemoteServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private sendError(ws: WebSocket, message: string): void {
    this.send(ws, { kind: "error", message, serverNowMs: this.now() });
  }

  private stopPhone(deviceId: string): void {
    this.stopping.set(deviceId, this.now() + STOPPING_GRACE_MS);
    this.sendToDevice(deviceId, { kind: "control", command: { kind: "stop" }, serverNowMs: this.now() });
  }

  private isStopping(deviceId: string): boolean {
    const until = this.stopping.get(deviceId);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.stopping.delete(deviceId);
    return false;
  }

  private onOutputReport(deviceId: string, report: RemoteOutputReport): void {
    if (this.isStopping(deviceId)) return;
    const previous = this.activeOutput;
    if (previous !== null && previous.deviceId !== deviceId) {
      // Another phone took over; the old one steps back.
      this.stopPhone(previous.deviceId);
    }
    const name = this.deps.devices.list(new Set()).find((d) => d.id === deviceId)?.name ?? "Phone";
    this.setActiveOutput({ ...report, deviceId, deviceName: name, reportedAtMs: this.now() });
    // The phone owns playback now; the computer must not keep playing too.
    if (previous === null && this.deps.coordinator.getSnapshot().status === "playing") {
      void this.deps.coordinator.handleCommand({ kind: "pause" }).catch(() => undefined);
    }
  }

  private setActiveOutput(next: RemoteActiveOutput | null): void {
    const changedOwner = (this.activeOutput?.deviceId ?? null) !== (next?.deviceId ?? null);
    this.activeOutput = next;
    if (changedOwner) {
      const text = JSON.stringify({
        kind: "session",
        activeDeviceId: next?.deviceId ?? null,
        serverNowMs: this.now(),
      } satisfies RemoteServerMessage);
      for (const ws of this.sockets.keys()) if (ws.readyState === ws.OPEN) ws.send(text);
    }
    this.emitStatus();
  }

  private isOnline(deviceId: string): boolean {
    for (const info of this.sockets.values()) if (info.deviceId === deviceId) return true;
    return false;
  }

  /** Send to every open socket of one device. False when none is open. */
  private sendToDevice(deviceId: string, msg: RemoteServerMessage): boolean {
    let sent = false;
    for (const [ws, info] of this.sockets) {
      if (info.deviceId !== deviceId || ws.readyState !== ws.OPEN) continue;
      ws.send(JSON.stringify(msg));
      sent = true;
    }
    return sent;
  }

  /** Resolve true once the computer reports `queueId` playing, false on timeout. */
  private waitForLocalStart(queueId: string): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(false);
      }, RECLAIM_START_TIMEOUT_MS);
      const off = this.deps.coordinator.onEvent((e) => {
        if (e.kind !== "snapshot" || e.snapshot.status !== "playing" || e.snapshot.current?.queueId !== queueId) return;
        clearTimeout(timer);
        off();
        resolve(true);
      });
    });
  }

  private async refreshAddresses(): Promise<void> {
    if (this.state.kind !== "on") return;
    const addresses = (this.deps.listAddresses ?? lanAddresses)();
    if (addresses.join(",") === this.state.addresses.join(",")) return;
    this.state = { ...this.state, addresses };
    this.deps.log?.(`phone sync addresses changed: ${addresses.join(", ") || "none"}`);
    // An open pairing QR must carry the new addresses.
    if (this.pairing !== null) {
      const link = buildPairLink({ hosts: addresses, port: this.state.port, code: this.pairing.code, name: this.deps.hostName });
      this.pairing = { ...this.pairing, link, qrSvg: await this.deps.renderQr(link) };
    }
    this.emitStatus();
  }

  private checkHeartbeats(): void {
    for (const [ws, info] of this.sockets) {
      if (!info.alive) {
        ws.terminate();
        continue;
      }
      info.alive = false;
      ws.ping();
    }
  }

  // --- status ----------------------------------------------------------------------------

  private armPairingExpiry(expiresAtMs: number): void {
    if (this.pairingTimer !== null) clearTimeout(this.pairingTimer);
    this.pairingTimer = setTimeout(
      () => {
        this.deps.devices.closePairing();
        this.clearPairing();
        this.emitStatus();
      },
      Math.max(0, expiresAtMs - this.now()),
    );
  }

  private clearPairing(): void {
    if (this.pairingTimer !== null) clearTimeout(this.pairingTimer);
    this.pairingTimer = null;
    this.pairing = null;
  }

  private emitStatus(): void {
    const s = this.status();
    for (const cb of this.listeners) cb(s);
  }
}
