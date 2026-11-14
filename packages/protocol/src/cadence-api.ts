/**
 * The contextBridge surface exposed to the renderer as `window.cadence`.
 * apps/desktop implements it in preload; apps/ui consumes it (with a mock
 * implementation for standalone `vite dev`).
 */

import type {
  CoordinatorEvent,
  LibraryAlbum,
  LibraryCounts,
  LibraryQuery,
  PlaybackCommand,
  PlaybackSnapshot,
  QueueState,
  RouteCapabilities,
  RouteId,
  ScanProgress,
  TrackRef,
} from "./index.js";
import type { CatalogPage, CatalogRequest, PlatformId } from "./catalog.js";
import type { RemoteStatus } from "./remote.js";

export interface CadenceApi {
  // --- playback -------------------------------------------------------------
  sendCommand(cmd: PlaybackCommand): Promise<void>;
  getSnapshot(): Promise<PlaybackSnapshot>;
  getQueue(): Promise<QueueState>;
  getCapabilities(): Promise<RouteCapabilities[]>;

  /** Subscribe to coordinator events. Returns an unsubscribe function. */
  onEvent(cb: (e: CoordinatorEvent) => void): () => void;

  // --- library ---------------------------------------------------------------
  library: {
    tracks(q?: LibraryQuery): Promise<TrackRef[]>;
    albums(q?: LibraryQuery): Promise<LibraryAlbum[]>;
    artists(q?: LibraryQuery): Promise<{ name: string; albumCount: number; trackCount: number }[]>;
    track(id: string): Promise<TrackRef | null>;
    /** Totals for the whole library, without loading it. */
    counts(): Promise<LibraryCounts>;
    /** Pick folders via native dialog and start a scan. Returns false if cancelled. */
    addFoldersAndScan(): Promise<boolean>;
    scan(paths: string[]): Promise<void>;
    onScanProgress(cb: (p: ScanProgress) => void): () => void;
    roots(): Promise<string[]>;
    removeRoots(paths: string[]): Promise<unknown>;
    /**
     * Pick a lyrics file (.lrc or .txt) for a local track and attach it.
     * Resolves to the updated track, or null if the dialog was cancelled.
     */
    importLyrics(trackId: string): Promise<TrackRef | null>;
    /** Shift a local track's lyric timing; positive shows lines later. */
    setLyricsOffset(trackId: string, offsetMs: number): Promise<TrackRef | null>;
  };

  // --- audio engine ------------------------------------------------------------
  audio: {
    /** Parametric EQ bands (center freq Hz + gain dB). Empty array = flat. */
    setEq(bands: { freqHz: number; gainDb: number }[]): Promise<void>;
    listDevices(): Promise<{ name: string; isDefault: boolean }[]>;
    setDevice(name: string | null): Promise<void>;
  };

  // --- routes / providers ------------------------------------------------------
  routes: {
    /** Trigger a route's sign-in flow (opens its view/focuses window). */
    signIn(route: RouteId): Promise<void>;
    signOut(route: RouteId): Promise<void>;
  };

  // --- streaming platform -----------------------------------------------------
  platform: {
    /** The single active streaming platform ("local" = none). Persisted. */
    active(): Promise<PlatformId>;
    setActive(platform: PlatformId): Promise<void>;
  };

  // --- provider catalog ---------------------------------------------------------
  catalog: {
    /**
     * The provider-neutral browse surface: search, home, browse, radio,
     * detail pages, user library and lyrics. Rejects when the route has no
     * catalog implementation or the provider call fails — callers surface
     * the message honestly.
     */
    query(route: RouteId, request: CatalogRequest): Promise<CatalogPage>;
  };

  // --- search -------------------------------------------------------------------
  search: {
    /**
     * Search a provider's catalog. Rejects when the route has no adapter,
     * the adapter does not implement search, or the provider call fails —
     * the UI surfaces the message honestly.
     */
    provider(route: RouteId, text: string): Promise<TrackRef[]>;
  };

  // --- phone sync -----------------------------------------------------------------
  remote: {
    status(): Promise<RemoteStatus>;
    /** Start or stop the LAN server phones connect to. Persisted. */
    setEnabled(enabled: boolean): Promise<RemoteStatus>;
    /** Open a five-minute pairing window with a code and QR. */
    startPairing(): Promise<RemoteStatus>;
    cancelPairing(): Promise<RemoteStatus>;
    /** Forget a paired phone; its token stops working at once. */
    revoke(deviceId: string): Promise<RemoteStatus>;
    /** Ask an online phone to take over playback where the computer is. */
    handoff(deviceId: string): Promise<RemoteStatus>;
    /** Move playback from the phone back to this computer at the phone's position. */
    reclaim(): Promise<RemoteStatus>;
    onStatus(cb: (s: RemoteStatus) => void): () => void;
  };

  // --- app ---------------------------------------------------------------------
  app: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    platform: string;
    versions: { electron: string; chrome: string; app: string };
  };
}

declare global {
  interface Window {
    cadence?: CadenceApi;
  }
}
