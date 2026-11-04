/**
 * ProviderSession — an account-scoped, sandboxed hidden playback view for a
 * streaming provider page (music.youtube.com, music.apple.com, open.spotify.com).
 *
 * Design follows the v3 architecture: each provider runs in its own persistent
 * Electron partition (login survives view teardown), the view stays alive while
 * its route is active or prepared as successor, and a narrow preload bridge
 * carries validated events page -> adapter. Commands travel the other way via
 * webContents.executeJavaScript into the page world.
 */

import { BrowserWindow, session, webContents, type WebContents } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Works under both the bundled CJS build (tsup emits __dirname) and ESM.
const moduleDir =
  typeof __dirname === "string"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

export interface ProviderSessionOptions {
  /** Session partition key, e.g. "persist:provider-youtube". */
  partition: string;
  /** Initial URL to load, e.g. https://music.youtube.com */
  url: string;
  /** Preload bundle path (defaults to the bundled provider preload). */
  preloadPath?: string;
  /** Called for every event posted by the injected controller. */
  onEvent?: (event: { name: string; data: unknown }) => void;
}

export class ProviderSession {
  readonly partition: string;
  private win: BrowserWindow | null = null;
  private listeners = new Set<(e: { name: string; data: unknown }) => void>();
  private readyPromise: Promise<void> | null = null;
  private userAgentTouched = false;

  constructor(private opts: ProviderSessionOptions) {
    this.partition = opts.partition;
    if (opts.onEvent) this.listeners.add(opts.onEvent);
  }

  get webContents(): WebContents | null {
    return this.win?.webContents ?? null;
  }

  get alive(): boolean {
    return this.win !== null && !this.win.webContents.isDestroyed();
  }

  /** Create (or reuse) the hidden playback view. Idempotent. */
  async prepare(): Promise<void> {
    if (this.alive) return;
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = (async () => {
      const ses = session.fromPartition(this.partition);
      const win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 800,
        webPreferences: {
          session: ses,
          preload: this.opts.preloadPath ?? join(moduleDir, "provider-preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          // Keep playback alive while hidden; the coordinator owns audibility.
          backgroundThrottling: false,
        },
      });

      // Route provider events posted through the preload bridge.
      win.webContents.on("ipc-message", (_e, channel, name, data) => {
        if (channel !== "cadence:provider-event") return;
        const evt = { name: String(name), data };
        for (const l of this.listeners) l(evt);
      });

      // A provider page crashing or being killed is a route-local failure:
      // report it, never take the app down.
      win.webContents.on("render-process-gone", (_e, details) => {
        for (const l of this.listeners)
          l({ name: "viewGone", data: { reason: details.reason } });
      });

      win.webContents.setWindowOpenHandler(({ url }) => {
        // Provider sign-in popups must open in the same account partition.
        return { action: "allow", overrideBrowserWindowOptions: { show: true } };
      });

      // Assign before loadURL: reveal() and eval() see the window even while
      // the page is still loading (or the load fails).
      this.win = win;
      try {
        await win.loadURL(this.opts.url);
      } catch (e) {
        // Don't leak the failed hidden window — destroy so a retry starts clean.
        this.win = null;
        if (!win.isDestroyed()) win.destroy();
        throw e;
      }
    })();

    try {
      await this.readyPromise;
    } finally {
      this.readyPromise = null;
    }
  }

  /** Run a command inside the page world. Serialized + validated strings only. */
  async eval<T = unknown>(expression: string): Promise<T> {
    if (!this.alive) throw new Error(`provider session ${this.partition} is not alive`);
    // A wedged provider page must not stall the coordinator chain.
    const result = await Promise.race([
      this.win!.webContents.executeJavaScript(expression, true),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`provider eval timed out on ${this.partition}`)), 10_000),
      ),
    ]);
    return result as T;
  }

  onEvent(cb: (e: { name: string; data: unknown }) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Cookie header for the provider origin, so catalog clients (InnerTube,
   * MusicKit) can share the login the view established. Reads the partition
   * session — no live view required. Returns undefined when no cookies are
   * stored or the read fails; callers treat that as anonymous access.
   */
  async cookieHeader(): Promise<string | undefined> {
    try {
      const ses = session.fromPartition(this.partition);
      const cookies = await ses.cookies.get({ url: this.opts.url });
      if (!cookies.length) return undefined;
      return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    } catch {
      return undefined;
    }
  }

  /** Destroy the view. The session partition (and login) persists. */
  async release(): Promise<void> {
    if (!this.alive) return;
    const win = this.win!;
    this.win = null;
    if (!win.isDestroyed()) win.destroy();
  }

  async dispose(): Promise<void> {
    await this.release();
    this.listeners.clear();
  }

  /** Hard mute the page — real silence even if JS-level pause fails. */
  setAudioMuted(muted: boolean): void {
    if (this.win !== null && !this.win.webContents.isDestroyed()) {
      this.win.webContents.setAudioMuted(muted);
    }
  }

  /** Show the view (sign-in flow). Caller decides how to surface it. */
  reveal(): void {
    this.win?.show();
    this.win?.focus();
  }

  hide(): void {
    this.win?.hide();
  }
}
