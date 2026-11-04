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
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

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
          preload: this.opts.preloadPath ?? join(__dirname, "provider-preload.cjs"),
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

      await win.loadURL(this.opts.url);
      this.win = win;
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
    return (await this.win!.webContents.executeJavaScript(expression, true)) as T;
  }

  onEvent(cb: (e: { name: string; data: unknown }) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
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

  /** Show the view (sign-in flow). Caller decides how to surface it. */
  reveal(): void {
    this.win?.show();
    this.win?.focus();
  }

  hide(): void {
    this.win?.hide();
  }
}
