/**
 * The contextBridge surface exposed to the renderer as `window.cadence`.
 * apps/desktop implements it in preload; apps/ui consumes it (with a mock
 * implementation for standalone `vite dev`).
 */

import type {
  CoordinatorEvent,
  LibraryAlbum,
  LibraryQuery,
  PlaybackCommand,
  PlaybackSnapshot,
  QueueState,
  RouteCapabilities,
  RouteId,
  ScanProgress,
  TrackRef,
} from "./index.js";

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
    /** Pick folders via native dialog and start a scan. Returns false if cancelled. */
    addFoldersAndScan(): Promise<boolean>;
    scan(paths: string[]): Promise<void>;
    onScanProgress(cb: (p: ScanProgress) => void): () => void;
    roots(): Promise<string[]>;
    removeRoots(paths: string[]): Promise<unknown>;
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

  // --- search -------------------------------------------------------------------
  search: {
    /**
     * Search a provider's catalog. Rejects when the route has no adapter,
     * the adapter does not implement search, or the provider call fails —
     * the UI surfaces the message honestly.
     */
    provider(route: RouteId, text: string): Promise<TrackRef[]>;
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
