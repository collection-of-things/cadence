import { contextBridge, ipcRenderer } from "electron";
import type {
  CadenceApi,
  CatalogRequest,
  CoordinatorEvent,
  LibraryQuery,
  PlatformId,
  PlaybackCommand,
  RouteId,
  ScanProgress,
} from "@cadence/protocol";
import { IpcChannels as C } from "./ipc-channels.js";

/**
 * The window.cadence bridge. This file is the ONLY place renderer-facing
 * wiring lives: it exposes the contract surface exactly, one thin forwarder
 * per channel, and keeps Node/Electron primitives out of the sandbox.
 */

function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  return ipcRenderer.invoke(channel, payload) as Promise<T>;
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => {
    cb(payload);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: CadenceApi = {
  sendCommand: (cmd: PlaybackCommand) => invoke(C.command, cmd),
  getSnapshot: () => invoke(C.snapshot),
  getQueue: () => invoke(C.queue),
  getCapabilities: () => invoke(C.capabilities),
  onEvent: (cb: (e: CoordinatorEvent) => void) => subscribe(C.event, cb),

  library: {
    tracks: (q?: LibraryQuery) => invoke(C.libraryTracks, q),
    albums: (q?: LibraryQuery) => invoke(C.libraryAlbums, q),
    artists: (q?: LibraryQuery) => invoke(C.libraryArtists, q),
    track: (id: string) => invoke(C.libraryTrack, id),
    counts: () => invoke(C.libraryCounts),
    addFoldersAndScan: () => invoke(C.libraryAddFolders),
    scan: (paths: string[]) => invoke(C.libraryScan, paths),
    onScanProgress: (cb: (p: ScanProgress) => void) => subscribe(C.scanProgress, cb),
    roots: () => invoke(C.libraryRoots),
    removeRoots: (paths: string[]) => invoke(C.libraryRemoveRoots, paths),
    importLyrics: (trackId: string) => invoke(C.libraryImportLyrics, trackId),
    setLyricsOffset: (trackId: string, offsetMs: number) =>
      invoke(C.librarySetLyricsOffset, { trackId, offsetMs }),
  },

  audio: {
    setEq: (bands: { freqHz: number; gainDb: number }[]) => invoke(C.audioSetEq, bands),
    listDevices: () => invoke(C.audioListDevices),
    setDevice: (name: string | null) => invoke(C.audioSetDevice, name),
  },

  routes: {
    signIn: (route: RouteId) => invoke(C.routeSignIn, route),
    signOut: (route: RouteId) => invoke(C.routeSignOut, route),
  },

  platform: {
    active: () => invoke(C.platformGet),
    setActive: (platform: PlatformId) => invoke(C.platformSet, platform),
  },

  catalog: {
    query: (route: RouteId, request: CatalogRequest) =>
      invoke(C.catalogQuery, { route, request }),
  },

  search: {
    provider: (route: RouteId, text: string) => invoke(C.searchProvider, { route, text }),
  },

  app: {
    minimize: () => {
      void invoke(C.windowMinimize);
    },
    toggleMaximize: () => {
      void invoke(C.windowToggleMaximize);
    },
    close: () => {
      void invoke(C.windowClose);
    },
    platform: process.platform,
    versions: {
      electron: process.versions.electron ?? "",
      chrome: process.versions.chrome ?? "",
      // Injected by the main process before preload runs (app.getVersion()).
      app: process.env.CADENCE_APP_VERSION ?? "0.1.0",
    },
  },
};

contextBridge.exposeInMainWorld("cadence", api);
