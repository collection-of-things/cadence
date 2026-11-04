import { app, BrowserWindow, dialog, powerMonitor } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AdapterRegistry } from "./adapters/registry.js";
import { LocalRouteAdapter } from "./adapters/local-route-adapter.js";
import { makePlaceholderAdapter, providerRoutes } from "./adapters/placeholders.js";
import { createProviderAdapters } from "./adapters/providers/index.js";
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
  // Real provider adapters (hidden ECS views + librespot PCM route).
  const registered = new Set(["local"]);
  for (const adapter of createProviderAdapters({
    graph: audioClient,
    apple: {
      getDeveloperToken: async () => process.env.CADENCE_APPLE_DEVELOPER_TOKEN ?? null,
    },
    spotify: {
      getCredentials: async () => {
        const username = process.env.CADENCE_SPOTIFY_USERNAME;
        const password = process.env.CADENCE_SPOTIFY_PASSWORD;
        const accessToken = process.env.CADENCE_SPOTIFY_ACCESS_TOKEN;
        if (accessToken) return { accessToken };
        if (username) return { username, password: password ?? "" };
        return null;
      },
      getAccessToken: async () => process.env.CADENCE_SPOTIFY_TOKEN ?? null,
    },
  })) {
    registry.register(adapter);
    registered.add(adapter.route);
  }
  // Honest placeholders only for routes a real adapter did not cover.
  for (const route of providerRoutes()) {
    if (!registered.has(route)) registry.register(makePlaceholderAdapter(route));
  }

  const coordinator = new Coordinator({
    registry,
    store,
    graphEvents: audioClient,
  });
  audioClient.onRestarted(() => {
    void coordinator.notifyEngineRestarted(coordinator.activeRoute ?? "local");
  });

  // Sleep/wake: pause on suspend so nothing keeps sounding over a lid-close
  // or a hung device path; resume only when we were the ones who paused.
  let suspendPaused = false;
  powerMonitor.on("suspend", () => {
    if (coordinator.getSnapshot().status === "playing") {
      suspendPaused = true;
      void coordinator.handleCommand({ kind: "pause" });
    }
  });
  powerMonitor.on("resume", () => {
    if (suspendPaused) {
      suspendPaused = false;
      void coordinator.handleCommand({ kind: "resume" });
    }
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

  const unbindEvents = registerIpcHandlers({
    coordinator,
    library,
    registry,
    routeSignIn: async (route) => {
      const adapter = registry.get(route);
      if (!adapter?.signIn) throw new Error(`route "${route}" has no sign-in flow`);
      await adapter.signIn();
    },
    routeSignOut: async (route) => {
      await registry.get(route)?.signOut?.();
    },
  });
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
