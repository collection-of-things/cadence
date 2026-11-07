import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  net,
  powerMonitor,
  protocol,
  Tray,
} from "electron";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { PlatformId } from "@cadence/protocol";
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
import { wireCloseToTray } from "./quit-guard.js";

/**
 * Composition root: parse environment, construct adapters + services, wire
 * the coordinator, open the main window. All domain/policy logic lives in
 * the modules; this file only wires concrete pieces together.
 */

// --- environment (must run before app is ready) -------------------------------
// CADENCE_USER_DATA: pin the profile dir (e2e reuses a signed-in profile).
if (process.env.CADENCE_USER_DATA) {
  app.setPath("userData", process.env.CADENCE_USER_DATA);
}
// CADENCE_E2E_CDP_PORT: expose Chrome DevTools Protocol for headless driving.
// Dev-only surface — never in packaged builds (a local process could drive a
// signed-in provider session through it).
if (process.env.CADENCE_E2E_CDP_PORT && !app.isPackaged) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.CADENCE_E2E_CDP_PORT);
}
// CADENCE_DISABLE_SANDBOX=1: boxes without kernel user-namespace support
// cannot start the Chromium sandbox at all. --no-zygote is then required on
// Linux (zygote-based child spawn fails); Chromium rejects it with sandbox on.
const sandboxDisabled =
  process.env.CADENCE_DISABLE_SANDBOX === "1" || process.env.ELECTRON_DISABLE_SANDBOX === "1";
if (sandboxDisabled) {
  app.commandLine.appendSwitch("no-sandbox");
  if (process.platform === "linux") {
    app.commandLine.appendSwitch("no-zygote");
  }
}
app.setName("cadence");

// apps/desktop -> repo root (CADENCE_AUDIO_BIN overrides the binary path in
// packaged builds where this layout no longer applies).
const appDir = app.getAppPath();
const repoRoot = join(appDir, "..", "..");
const distDir = join(appDir, "dist");
let uiRootPath: string | null = null;

// Artwork is served to the sandboxed renderer over a narrow scheme instead
// of raw file:// (blocked under http dev origins and future served UI).
protocol.registerSchemesAsPrivileged([
  {
    scheme: "cadence-art",
    privileges: { supportFetchAPI: true, stream: true, bypassCSP: false },
  },
  {
    // The UI bundle loads over this scheme: <script type="module"> is
    // CORS-blocked over file://, and a real origin also unblocks fonts,
    // workers, and fetch(). cadence-app://ui/index.html maps to uiRoot.
    scheme: "cadence-app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

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
  const uiRoot = app.isPackaged
    ? join(process.resourcesPath, "ui")
    : join(repoRoot, "apps", "ui", "dist");
  if (existsSync(join(uiRoot, "index.html"))) {
    uiRootPath = uiRoot;
    void win.loadURL("cadence-app://ui/index.html");
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
      if (!win.isVisible()) win.show();
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
  const thumbDir = join(userData, "thumbnails");
  let thumbRoot = resolve(thumbDir);
  try {
    thumbRoot = realpathSync(thumbDir);
  } catch {
    /* thumbnails dir may not exist until the first scan */
  }
  protocol.handle("cadence-app", (request) => {
    // Serves the built UI bundle; module scripts need a real origin.
    const u = new URL(request.url);
    if (u.host !== "ui" || uiRootPath === null) return new Response(null, { status: 404 });
    const candidate = resolve(join(uiRootPath, decodeURIComponent(u.pathname).replace(/^\//, "")));
    if (!candidate.startsWith(uiRootPath + sep)) return new Response(null, { status: 403 });
    return net.fetch(pathToFileURL(candidate).toString());
  });
  protocol.handle("cadence-art", (request) => {
    const u = new URL(request.url);
    if (u.host !== "artwork") return new Response(null, { status: 404 });
    const candidate = resolve(decodeURIComponent(u.pathname.slice(1)));
    if (!candidate.startsWith(thumbRoot + sep)) return new Response(null, { status: 403 });
    return net.fetch(pathToFileURL(candidate).toString());
  });
  const store = new SettingsStore(settingsPath(userData));

  const audioClient = new AudioServiceClient({
    binaryPath: () =>
      resolveAudioBinary(
        process.env,
        repoRoot,
        app.isPackaged ? process.resourcesPath : undefined,
      ),
    onLog: (line) => console.error(`[cadence-audio] ${line}`),
  });
  const localAdapter = new LocalRouteAdapter(audioClient);

  const registry = new AdapterRegistry();
  registry.register(localAdapter);
  // Real provider adapters (hidden ECS views + librespot PCM route).
  const registered = new Set(["local"]);
  for (const adapter of createProviderAdapters({
    graph: audioClient,
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
  // Service loss is a route-local failure of whichever engine route owns the
  // shared graph — surface it immediately, not only after a respawn.
  audioClient.onStateChange((s) => {
    if (s === "down" || s === "failed") {
      coordinator.notifyEngineUnavailable(coordinator.activeRoute ?? "local");
    }
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
  const scanner = new LibraryScanner(thumbDir, {
    // Downscale embedded art once at scan time — lists decode 512px, not the
    // original 5-15MB masters.
    resize: async (data) => {
      const img = nativeImage.createFromBuffer(Buffer.from(data));
      if (img.isEmpty()) return null;
      const resized = img.resize({ width: 512, quality: "good" });
      return new Uint8Array(resized.toPNG());
    },
  });
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
    mainWindow: () =>
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("cadence-app")) ??
      BrowserWindow.getAllWindows()[0] ??
      null,
    coordinator,
    library,
    registry,
    audio: audioClient,
    routeSignIn: async (route) => {
      const adapter = registry.get(route);
      if (!adapter?.signIn) throw new Error(`route "${route}" has no sign-in flow`);
      await adapter.signIn();
    },
    routeSignOut: async (route) => {
      // Signing out of the ACTIVE provider drops the platform back to local.
      const platform: PlatformId = route.startsWith("spotify")
        ? "spotify"
        : route.startsWith("apple")
          ? "apple"
          : route.startsWith("youtube")
            ? "youtube"
            : "local";
      const active = (store.loadSection("platform") as { active?: string })?.active;
      if (active === platform) {
        store.saveSection("platform", { active: "local" });
      }
    },
    platform: {
      // One streaming platform at a time; "local" means none is active.
      // Persisted in the same settings document as playback/library state.
      active: async (): Promise<PlatformId> => {
        const section = store.loadSection("platform");
        const active =
          typeof section === "object" && section !== null
            ? (section as { active?: unknown }).active
            : undefined;
        return active === "apple" || active === "spotify" || active === "youtube"
          ? active
          : "local";
      },
      setActive: async (platform) => {
        store.saveSection("platform", { active: platform });
      },
    },
  });
  const unregisterKeys = registerMediaKeys(coordinator);

  // Close-to-tray: the window hides, playback continues — per the v3 design
  // provider playback must survive the main window closing. Explicit Quit
  // only from the tray menu (or app.quit() paths like single-instance);
  // before-quit arms the guard so programmatic quit paths can still close.
  let tray: Tray | null = null;
  const win = createWindow();
  const { requestQuit } = wireCloseToTray({
    onBeforeQuit: (cb) => app.on("before-quit", cb),
    onWindowClose: (cb) => win.on("close", cb),
    hideWindow: () => win.hide(),
  });

  // 16x16 dark rounded-square with a C — enough for a tray icon.
  const trayIcon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAM0lEQVR4nGNgGAWDHjAyMDAw/P//nxGXAgYGhv+EVcAwCoZ0YBgFgx0YRsFgB4ZRMPCBAQD//wMAaWkX7v8fXv0AAAAASUVORK5CYII=",
  );
  tray = new Tray(trayIcon);
  tray.setToolTip("Cadence");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Cadence", click: () => win.show() },
      { type: "separator" },
      {
        label: "Quit",
        // requestQuit() is belt-and-braces: before-quit already arms the
        // guard, but arming here covers any quit path that bypasses it.
        click: () => {
          requestQuit();
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", () => win.show());

  app.on("activate", () => {
    win.show();
  });
  app.on("window-all-closed", () => {
    // Intentionally empty: windows hide instead of closing; the app exits
    // only through the explicit Quit path above.
  });
  app.on("will-quit", () => {
    unregisterKeys();
    unbindEvents();
    tray?.destroy();
    tray = null;
    coordinator.dispose();
    void library.dispose();
    for (const adapter of registry.list()) {
      void adapter.dispose();
    }
    void audioClient.dispose();
  });
}

void main();
