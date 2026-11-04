import { BrowserWindow, ipcMain } from "electron";
import type { CoordinatorEvent, RouteId } from "@cadence/protocol";
import type { Coordinator } from "./coordinator/coordinator.js";
import type { AdapterRegistry } from "./adapters/registry.js";
import type { LibraryService } from "./library/library-service.js";
import { IpcChannels as C } from "./ipc-channels.js";
import { isOk } from "./result.js";
import {
  InvalidIpcPayload,
  parseLibraryQuery,
  parsePaths,
  parsePlaybackCommand,
  parseEqBands,
  parseProviderSearch,
  parseRouteId,
  parseTrackId,
} from "./ipc-validation.js";

/** Inbound adapters for window.cadence. */
export interface IpcDeps {
  readonly coordinator: Coordinator;
  readonly library: LibraryService;
  readonly registry: AdapterRegistry;
  /** Route sign-in hooks; real provider adapters wire theirs in later. */
  readonly routeSignIn?: (route: RouteId) => Promise<void>;
  readonly routeSignOut?: (route: RouteId) => Promise<void>;
  /** Engine passthrough for EQ + output-device control. */
  readonly audio?: {
    setEq(bands: { freqHz: number; gainDb: number }[]): Promise<unknown>;
    listDevices(): Promise<unknown>;
    setDevice(name: string | null): Promise<unknown>;
  };
}

function assertOk<T>(r: { _tag: string; value?: T; error?: unknown }): T {
  if (r._tag !== "ok") throw r.error;
  // SAFETY: r._tag === "ok" guarantees value is present (Result contract).
  return r.value as T;
}

/**
 * Register every window.cadence channel on ipcMain and fan coordinator /
 * library events out to all renderer windows. All inbound payloads are
 * parsed through ipc-validation before touching application code.
 */
export function registerIpcHandlers(deps: IpcDeps): () => void {
  const { coordinator, library, registry } = deps;

  ipcMain.handle(C.command, async (_e, payload: unknown) => {
    await coordinator.handleCommand(assertOk(parsePlaybackCommand(payload)));
  });
  ipcMain.handle(C.snapshot, () => coordinator.getSnapshot());
  ipcMain.handle(C.queue, () => coordinator.getQueue());
  ipcMain.handle(C.capabilities, () => coordinator.getCapabilities());

  ipcMain.handle(C.libraryTracks, (_e, q: unknown) =>
    library.tracks(assertOk(parseLibraryQuery(q))),
  );
  ipcMain.handle(C.libraryAlbums, (_e, q: unknown) =>
    library.albums(assertOk(parseLibraryQuery(q))),
  );
  ipcMain.handle(C.libraryArtists, (_e, q: unknown) =>
    library.artists(assertOk(parseLibraryQuery(q))),
  );
  ipcMain.handle(C.libraryTrack, (_e, id: unknown) =>
    library.track(assertOk(parseTrackId(id))),
  );
  ipcMain.handle(C.libraryAddFolders, () => library.addFoldersAndScan());
  ipcMain.handle(C.libraryScan, async (_e, paths: unknown) => {
    await library.scan(assertOk(parsePaths(paths)));
  });
  ipcMain.handle(C.libraryRoots, () => library.roots());
  ipcMain.handle(C.libraryRemoveRoots, (_e, paths: unknown) => {
    const parsed = parsePaths(paths);
    if (isOk(parsed)) library.removeRoots(parsed.value);
    return parsed;
  });

  if (deps.audio !== undefined) {
    const audio = deps.audio;
    ipcMain.handle(C.audioSetEq, async (_e, payload: unknown) => {
      const bands = assertOk(parseEqBands(payload));
      await audio.setEq(bands);
    });
    ipcMain.handle(C.audioListDevices, () => audio.listDevices());
    ipcMain.handle(C.audioSetDevice, async (_e, payload: unknown) => {
      if (payload !== null && typeof payload !== "string")
        throw new InvalidIpcPayload("setDevice expects a device name or null");
      await audio.setDevice(payload as string | null);
    });
  }

  ipcMain.handle(C.routeSignIn, async (_e, route: unknown) => {
    const r = assertOk(parseRouteId(route));
    if (deps.routeSignIn !== undefined) {
      await deps.routeSignIn(r);
      return;
    }
    if (registry.get(r) === undefined) throw new InvalidIpcPayload(`no adapter for ${r}`);
    throw new Error(`sign-in for route "${r}" is not implemented yet`);
  });
  ipcMain.handle(C.routeSignOut, async (_e, route: unknown) => {
    const r = assertOk(parseRouteId(route));
    if (deps.routeSignOut !== undefined) await deps.routeSignOut(r);
  });

  // Provider catalog search. Routes whose adapter omits `search` fail
  // honestly here rather than returning fabricated results.
  ipcMain.handle(C.searchProvider, async (_e, payload: unknown) => {
    const { route, text } = assertOk(parseProviderSearch(payload));
    const adapter = registry.get(route);
    if (adapter?.search === undefined) {
      throw new Error(`search is not available for route "${route}"`);
    }
    // Bound catalog calls — a hung provider page must not wedge the UI.
    return Promise.race([
      adapter.search(text),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`search on route "${route}" timed out`)), 15_000),
      ),
    ]);
  });

  ipcMain.handle(C.windowMinimize, (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize();
  });
  ipcMain.handle(C.windowToggleMaximize, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win === null) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle(C.windowClose, (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close();
  });

  // --- outbound events ----------------------------------------------------------
  const broadcast = (channel: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, payload);
    }
  };
  const unsubCoordinator = coordinator.onEvent((e: CoordinatorEvent) => {
    broadcast(C.event, e);
  });
  const unsubScan = library.onScanProgress((p) => {
    broadcast(C.scanProgress, p);
  });
  return () => {
    unsubCoordinator();
    unsubScan();
  };
}
