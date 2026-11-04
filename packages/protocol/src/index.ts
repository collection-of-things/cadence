/**
 * @cadence/protocol — shared contracts for Cadence.
 *
 * Every workstream codes against these types. The coordinator, route
 * adapters, the renderer and the Rust audio service all speak this
 * vocabulary. Keep additive changes backward compatible.
 */

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Playback routes. A route is a (provider, engine) pair, not just a provider. */
export type RouteId =
  | "local" // local library files -> Rust audio graph
  | "spotify-librespot" // librespot session -> Rust audio graph
  | "spotify-web" // Spotify web player in a hidden ECS view
  | "apple-musickit" // MusicKit JS in a hidden ECS view
  | "youtube-music"; // music.youtube.com player in a hidden ECS view

export type ProviderId = "local" | "spotify" | "apple" | "youtube";

// ---------------------------------------------------------------------------
// Capability records
// ---------------------------------------------------------------------------

/**
 * Routes report what they can actually do *right now*, distinguishing
 * "unknown" (not established) from "unsupported" (established not to work).
 * The coordinator/UI must never flatten unknown into unsupported.
 */
export type Tri = "yes" | "no" | "unknown";

export interface RouteCapabilities {
  route: RouteId;
  /** Auth/availability state of the route as a whole. */
  state: "ready" | "unauthenticated" | "unavailable" | "degraded" | "error";
  /** Human-readable reason for a non-ready state (sign-in required, key refused, DRM missing...). */
  stateDetail?: string;
  playback: {
    engine: "native-pcm" | "provider-engine" | "none";
    canPlay: boolean;
    canPause: boolean;
    canSeek: boolean;
    canNextPrevious: boolean;
    gapless: Tri; // engine-verified seamless transitions
    exclusiveOutput: Tri;
  };
  audio: {
    /** Real decoded PCM reaches our graph (EQ + true reactive visuals possible). */
    pcmAccess: Tri;
    eq: Tri;
    replayGain: Tri;
    /** e.g. "up to 24-bit/192kHz lossless" — honest per-route ceiling */
    qualityCeiling?: string;
  };
  visuals: {
    /** "pcm-fft" = real spectrum from our graph; "ambient" = artwork-driven only. */
    kind: "pcm-fft" | "ambient";
  };
  /** Free-form notes surfaced in the UI tooltip/settings, e.g. known provider limits. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Tracks and queue
// ---------------------------------------------------------------------------

export interface ArtistRef {
  name: string;
  providerId?: string;
}

export interface ArtworkRef {
  /** Cache key, file:// path, https URL or data URI. */
  url: string;
  width?: number;
  height?: number;
}

export type TrackSource =
  | { kind: "file"; path: string; format?: string }
  | { kind: "provider"; providerItemId: string; uri?: string };

export interface TrackRef {
  /** Globally unique: `${route}:${providerItemId-or-path-hash}`. */
  id: string;
  route: RouteId;
  provider: ProviderId;
  title: string;
  artists: ArtistRef[];
  album?: string;
  durationMs: number;
  trackNumber?: number;
  discNumber?: number;
  year?: number;
  genre?: string[];
  artwork?: ArtworkRef;
  source: TrackSource;
  /** ReplayGain track gain in dB, if known. */
  replayGainDb?: number;
  /** Honest per-track availability (region locks, key refusals). */
  availability: "available" | "unavailable" | "unknown";
  availabilityDetail?: string;
}

/**
 * A queue entry. `queueId` is unique per occurrence so a track can appear
 * twice and external provider edits can be reconciled deterministically.
 */
export interface QueueItem {
  queueId: string;
  track: TrackRef;
  /** Where it came from: album, playlist, manual add, provider mirror. */
  origin?: { kind: "album" | "playlist" | "manual" | "provider"; id?: string; name?: string };
}

export interface QueueState {
  /** Which authority owns queue truth for the *current* route. */
  owner: "coordinator" | "provider";
  items: QueueItem[];
  /** Index of the item currently loaded/playing, -1 if none. */
  currentIndex: number;
  /** Shuffle keeps a separate order mapping; items[] stays in base order. */
  shuffle: boolean;
  shuffleOrder?: number[];
  repeat: "off" | "all" | "one";
}

// ---------------------------------------------------------------------------
// Playback state, leases, commands, events
// ---------------------------------------------------------------------------

export type PlaybackStatus = "stopped" | "loading" | "playing" | "paused" | "buffering" | "error";

/**
 * A lease marks which generation of coordinator intent owns playback.
 * Events stamped with an older generation are ignored — prevents a dying
 * route's late events from reclaiming playback after a handoff.
 */
export interface PlaybackLease {
  generationId: number;
  route: RouteId;
  queueId: string;
  issuedAtMs: number;
}

export interface ActiveOutput {
  deviceName: string;
  /** Actual negotiated stream format, reported not assumed. */
  sampleRateHz: number;
  channels: number;
  bitDepth: number | "float";
  /** True when DSP/EQ/resample is bypassed end-to-end (strict fidelity mode). */
  fidelityBypass: boolean;
  exclusive: boolean;
}

export interface PlaybackSnapshot {
  status: PlaybackStatus;
  lease: PlaybackLease | null;
  current: QueueItem | null;
  positionMs: number;
  /** Position updates are timestamped; providers may report coarsely. */
  positionAtMs: number;
  durationMs: number;
  volume: number; // 0..1, remembered per route conservatively
  muted: boolean;
  output?: ActiveOutput;
  /** Per-route error, kept local to the route — never takes others down. */
  lastError?: { route: RouteId; queueId: string; message: string; retriable: boolean };
}

// Commands UI -> coordinator -------------------------------------------------

export type PlaybackCommand =
  | { kind: "setQueue"; items: QueueItem[]; startIndex?: number; autoplay?: boolean }
  | { kind: "insertNext"; items: QueueItem[] }
  | { kind: "append"; items: QueueItem[] }
  | { kind: "remove"; queueIds: string[] }
  | { kind: "move"; fromIndex: number; toIndex: number }
  | { kind: "play"; queueId?: string }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "stop" }
  | { kind: "next" }
  | { kind: "previous" }
  | { kind: "seek"; positionMs: number }
  | { kind: "setVolume"; volume: number }
  | { kind: "setMuted"; muted: boolean }
  | { kind: "setRepeat"; repeat: QueueState["repeat"] }
  | { kind: "setShuffle"; shuffle: boolean }
  | { kind: "switchRoute"; queueId: string; route: RouteId } // deliberate fallback on route failure
  | { kind: "setFidelityMode"; enabled: boolean };

// Events coordinator -> UI ----------------------------------------------------

export type CoordinatorEvent =
  | { kind: "snapshot"; snapshot: PlaybackSnapshot }
  | { kind: "queue"; queue: QueueState }
  | { kind: "capabilities"; route: RouteId; capabilities: RouteCapabilities }
  | { kind: "position"; positionMs: number; atMs: number; generationId: number }
  | { kind: "trackEnded"; queueId: string; generationId: number }
  | { kind: "error"; route: RouteId; queueId?: string; message: string; retriable: boolean }
  | { kind: "fft"; bands: number[]; peak: number; atMs: number; generationId: number }
  | { kind: "output"; output: ActiveOutput };

// ---------------------------------------------------------------------------
// Route adapter interface (desktop side)
// ---------------------------------------------------------------------------

/**
 * A route adapter drives one playback engine. All failures must be reported
 * through events and stay local to the route.
 */
export interface RouteAdapter {
  readonly route: RouteId;
  /** Recompute and return the current capability record. */
  capabilities(): Promise<RouteCapabilities>;
  /** Prepare the engine (spawn view/session). Idempotent. */
  prepare(): Promise<void>;
  /**
   * Load and (optionally) start a queue item under this lease. The adapter
   * must only honor events/commands while the lease generation is current.
   */
  play(item: QueueItem, lease: PlaybackLease, opts: { positionMs?: number }): Promise<void>;
  pause(lease: PlaybackLease): Promise<void>;
  resume(lease: PlaybackLease): Promise<void>;
  /** Confirmed mute or teardown — must leave nothing audible. */
  stop(lease: PlaybackLease): Promise<void>;
  seek(lease: PlaybackLease, positionMs: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  /** Best-effort prefetch of a successor for gapless-style handoff. */
  prefetch?(item: QueueItem): Promise<void>;
  /** Release idle engine resources without discarding the login session. */
  releaseIdle?(): Promise<void>;
  /**
   * Search the provider's catalog. Adapters without a catalog integration
   * omit this — callers must treat its absence as "search not available".
   * Expected failures (auth, network, parse) reject with a typed error
   * describing the real cause.
   */
  search?(text: string): Promise<TrackRef[]>;
  /** Trigger the route's sign-in flow (reveal view / open pairing). */
  signIn?(): Promise<void>;
  signOut?(): Promise<void>;
  dispose(): Promise<void>;
  /** Adapter -> coordinator event sink. */
  onEvent(cb: (e: AdapterEvent) => void): void;
}

export type AdapterEvent =
  | {
      kind: "started";
      generationId: number;
      durationMs?: number;
      /** The queue item the engine started — set when it self-promoted a
       *  prefetched successor (no coordinator play call preceded it). */
      queueId?: string;
      promoted?: boolean;
    }
  | { kind: "position"; positionMs: number; atMs: number; generationId: number }
  | { kind: "state"; status: PlaybackStatus; generationId: number }
  | {
      kind: "ended";
      generationId: number;
      /** true when the engine started the successor seamlessly itself. */
      gapless?: boolean;
    }
  | { kind: "queueChanged"; generationId: number; providerQueue?: unknown }
  | { kind: "error"; message: string; retriable: boolean; code?: string }
  | { kind: "capabilitiesChanged" };

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export interface LibraryAlbum {
  id: string;
  title: string;
  artist: string;
  year?: number;
  artwork?: ArtworkRef;
  trackCount: number;
}

export interface LibraryQuery {
  text?: string;
  artist?: string;
  album?: string;
  genre?: string;
  limit?: number;
  offset?: number;
}

export interface ScanProgress {
  phase: "idle" | "scanning" | "watching";
  scanned: number;
  total?: number;
  currentPath?: string;
}

export * from "./audio-ipc.js";
export * from "./cadence-api.js";
