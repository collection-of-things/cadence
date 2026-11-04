import { app, BrowserWindow, dialog } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AdapterRegistry } from "./adapters/registry.js";
import { LocalRouteAdapter } from "./adapters/local-route-adapter.js";
import { makePlaceholderAdapter, providerRoutes } from "./adapters/placeholders.js";
import { AudioServiceClient } from "./audio/audio-client.js";
import { resolveAudioBinary } from "./audio/binary-path.js";
import { Coordinator } from "./coordinator/coordinator.js";
import { SettingsStore, settingsPath } from "./coordinator/settings-store.js";
import { makeElectronFolderPicker } from "./library/folder-picker.js";
import { LibraryDb } from "./library/library-db.js";
import { LibraryScanner } from "./library/scanner.js";
import { LibraryService, chokidarWatcherFactory } from "./library/library-service.js";
import { registerIpcHandlers } from "./ipc.js";
import { registerMediaKeys } from "./media-keys.js";

/**
 * Composition root: parse environment, construct adapters + services, wire
 * the coordinator, open the main window. All domain/policy logic lives in
 * the modules; this file only wires concrete pieces together.
 */

// apps/desktop -> repo root (CADENCE_AUDIO_BIN overrides the binary path in
// packaged builds where this layout no longer applies).
const appDir = app.getAppPath();
const repoRoot = join(appDir, "..", "..");
const distDir = join(appDir, "dist");

process.env.CADENCE_APP_VERSION = app.getVersion();

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: "Cadence",
    backgroundColor: "#0c0d10",
    webPreferences: {
      preload: join(distDir, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const devUrl = process.env.CADENCE_UI_URL;
  if (devUrl !== undefined && devUrl !== "") {
    void win.loadURL(devUrl);
    return win;
  }
  const uiBundle = join(repoRoot, "apps", "ui", "dist", "index.html");
  if (existsSync(uiBundle)) {
    void win.loadFile(uiBundle);
  } else {
    // The UI workstream builds apps/ui in parallel; until then the shell
    // still boots and window.cadence is live for manual probing.
    void win.loadURL(
      "data:text/html,<title>Cadence</title><body style='background:%230c0d10;color:%23cdd;font-family:system-ui;display:grid;place-items:center;height:100vh'><p>Cadence shell — apps/ui bundle not found. Set CADENCE_UI_URL or build apps/ui.</p></body>",
    );
  }
  return win;
}

async function main(): Promise<void> {
  const singleInstance = app.requestSingleInstanceLock();
  if (!singleInstance) {
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win !== undefined) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  await app.whenReady();

  // Castlabs ECS: wait for the Widevine CDM component install before any
  // window can play protected media. Stock Electron has no `components` —
  // the check is a no-op there.
  const components = (app as unknown as { components?: { whenReady(): Promise<unknown> } })
    .components;
  if (components !== undefined) {
    try {
      await components.whenReady();
    } catch (e) {
      console.error("Widevine component install failed; DRM routes will degrade:", e);
    }
  }

  const userData = app.getPath("userData");
  const store = new SettingsStore(settingsPath(userData));

  const audioClient = new AudioServiceClient({
    binaryPath: () => resolveAudioBinary(process.env, repoRoot),
    onLog: (line) => console.error(`[cadence-audio] ${line}`),
  });
  const localAdapter = new LocalRouteAdapter(audioClient);

  const registry = new AdapterRegistry();
  registry.register(localAdapter);
  // Honest placeholders until the lead's providers land:
  //   registry.register(new YouTubeMusicAdapter(...)) replaces the stub via
  //   the same call — placeholders never shadow a real adapter.
  const placeholderRoutes = providerRoutes();
  for (const route of placeholderRoutes) registry.register(makePlaceholderAdapter(route));

  const coordinator = new Coordinator({
    registry,
    store,
    graphEvents: audioClient,
  });
  audioClient.onRestarted(() => {
    void coordinator.notifyEngineRestarted("local");
  });

  const db = new LibraryDb(join(userData, "library.db"));
  const scanner = new LibraryScanner(join(userData, "thumbnails"));
  const library = new LibraryService({
    db,
    scanner,
    store,
    pickFolders: makeElectronFolderPicker((opts) => dialog.showOpenDialog(opts)),
    createWatcher: chokidarWatcherFactory,
  });
  if (library.roots().length > 0) {
    library.startWatcher();
    void library.scan();
  }

  const unbindEvents = registerIpcHandlers({ coordinator, library, registry });
  const unregisterKeys = registerMediaKeys(coordinator);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("will-quit", () => {
    unregisterKeys();
    unbindEvents();
    coordinator.dispose();
    void library.dispose();
    void localAdapter.dispose();
    void audioClient.dispose();
  });

  createWindow();
}

void main();
