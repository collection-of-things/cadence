/**
 * Remote surface: the LAN link between the desktop app and a paired phone.
 *
 * The desktop runs a small HTTP + WebSocket server. A phone pairs once with
 * a short code the desktop shows (as text and as a QR code), receives a
 * bearer token, and from then on:
 *   - GET  /v1/info               host identity (no auth)
 *   - POST /v1/pair               code + device name -> token (no auth)
 *   - WS   /v1/live               hello, then coordinator events; accepts commands
 *   - GET  /v1/media/:trackId     a local library file, with Range support
 *   - GET  /v1/artwork/:trackId   a local track's cover thumbnail
 *
 * Playback ownership: one device plays at a time. A phone that takes over
 * sends `output` reports while it plays and `release` when it stops; the
 * desktop then routes its own transport controls to that phone (`control`)
 * and can ask a phone to take over (`handoff`). Every phone hears who owns
 * playback through `session`.
 *
 * Auth is `Authorization: Bearer <token>` or a `t=<token>` query parameter
 * (for players and image views that cannot set headers).
 */

import type { CoordinatorEvent, PlaybackCommand, PlaybackSnapshot, QueueState } from "./index.js";

export const REMOTE_PROTOCOL_VERSION = 1;
export const REMOTE_DEFAULT_PORT = 47820;

/** What `GET /v1/info` returns. Safe to show before pairing. */
export interface RemoteHostInfo {
  readonly app: "cadence";
  readonly protocol: number;
  /** Stable per desktop install; lets a phone recognise the same host on a new address. */
  readonly hostId: string;
  /** Human name, the computer's host name. */
  readonly name: string;
  readonly version: string;
}

export interface RemotePairRequest {
  readonly code: string;
  readonly deviceName: string;
}

export interface RemotePairResponse {
  readonly token: string;
  readonly deviceId: string;
  readonly host: RemoteHostInfo;
}

/**
 * Commands a paired device may send. Queue edits are left out: a setQueue
 * carries file paths, and a phone should never point the desktop engine at
 * arbitrary files.
 */
export type RemoteCommand = Extract<
  PlaybackCommand,
  {
    kind:
      | "play"
      | "pause"
      | "resume"
      | "stop"
      | "next"
      | "previous"
      | "seek"
      | "setVolume"
      | "setMuted"
      | "setRepeat"
      | "setShuffle";
  }
>;

export const REMOTE_COMMAND_KINDS: ReadonlySet<RemoteCommand["kind"]> = new Set([
  "play",
  "pause",
  "resume",
  "stop",
  "next",
  "previous",
  "seek",
  "setVolume",
  "setMuted",
  "setRepeat",
  "setShuffle",
]);

/** Coordinator events forwarded over the LAN. FFT frames stay on the desktop. */
export type RemoteForwardedEvent = Exclude<CoordinatorEvent, { kind: "fft" }>;

/**
 * Server -> phone. Every message carries the desktop clock so the phone can
 * project playback position without trusting its own clock to match.
 */
export type RemoteServerMessage =
  | {
      kind: "hello";
      host: RemoteHostInfo;
      deviceId: string;
      snapshot: PlaybackSnapshot;
      queue: QueueState;
      serverNowMs: number;
    }
  | { kind: "event"; event: RemoteForwardedEvent; serverNowMs: number }
  | { kind: "error"; message: string; serverNowMs: number }
  /** Who owns playback now: a phone's device id, or null for the computer. */
  | { kind: "session"; activeDeviceId: string | null; serverNowMs: number }
  /** Transport for the phone that owns playback. */
  | { kind: "control"; command: RemotePhoneCommand; serverNowMs: number }
  /** The desktop asks this phone to take over at this queue item and position. */
  | { kind: "handoff"; queueId: string; positionMs: number; serverNowMs: number };

/** Desktop -> phone transport, used while that phone owns playback. */
export type RemotePhoneCommand =
  | { kind: "play"; queueId: string }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "next" }
  | { kind: "previous" }
  | { kind: "seek"; positionMs: number }
  | { kind: "setVolume"; volume: number }
  /** Stop playing on the phone; playback moves back to the computer or ends. */
  | { kind: "stop" };

/** What a phone that owns playback reports, about once a second and on every change. */
export interface RemoteOutputReport {
  /** The desktop queue item the phone is playing (phones play a copy of that queue). */
  readonly queueId: string;
  readonly playing: boolean;
  readonly positionMs: number;
  readonly durationMs: number;
  /** 0..1, the phone player's own volume. */
  readonly volume: number;
}

/** Phone -> server. */
export type RemoteClientMessage =
  | { kind: "command"; command: RemoteCommand }
  | { kind: "ping" }
  /** This phone owns playback; sent while it plays or holds a paused session. */
  | { kind: "output"; output: RemoteOutputReport }
  /** This phone stopped owning playback. */
  | { kind: "release" };

// --- desktop UI side -------------------------------------------------------------

export interface RemotePairedDevice {
  readonly id: string;
  readonly name: string;
  readonly pairedAtMs: number;
  readonly lastSeenAtMs: number | null;
  readonly online: boolean;
}

export type RemoteServerState =
  | { kind: "off" }
  | { kind: "starting" }
  | { kind: "on"; port: number; addresses: string[] }
  | { kind: "error"; message: string };

/** An open pairing window: the code, when it closes, and the QR to scan. */
export interface RemotePairing {
  readonly code: string;
  readonly expiresAtMs: number;
  /** cadence://pair?... — what the QR code encodes. */
  readonly link: string;
  /** The QR code as a standalone SVG document. */
  readonly qrSvg: string;
}

/** A phone that owns playback, as the desktop last heard from it. */
export interface RemoteActiveOutput extends RemoteOutputReport {
  readonly deviceId: string;
  readonly deviceName: string;
  /** Desktop clock when the report arrived; project position from here while playing. */
  readonly reportedAtMs: number;
}

export interface RemoteStatus {
  readonly enabled: boolean;
  readonly server: RemoteServerState;
  readonly devices: RemotePairedDevice[];
  readonly pairing: RemotePairing | null;
  /** The phone playing right now, or null when the computer owns playback. */
  readonly activeOutput: RemoteActiveOutput | null;
}

/** Path of a local track's audio on the remote server. */
export function remoteMediaPath(trackId: string): string {
  return `/v1/media/${encodeURIComponent(trackId)}`;
}

/** Path of a local track's artwork on the remote server. */
export function remoteArtworkPath(trackId: string): string {
  return `/v1/artwork/${encodeURIComponent(trackId)}`;
}

/** Build the link a pairing QR code carries. */
export function buildPairLink(p: {
  hosts: readonly string[];
  port: number;
  code: string;
  name: string;
}): string {
  const q = new URLSearchParams({
    h: p.hosts.join(","),
    p: String(p.port),
    c: p.code,
    n: p.name,
  });
  return `cadence://pair?${q.toString()}`;
}
