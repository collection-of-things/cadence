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

import { BrowserWindow, session, type WebContents } from "electron";
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
  /**
   * Expression re-evaluated after every page load (in-page navigations wipe
   * injected state). Must be idempotent — controllers self-guard. A function
   * is called per load, so the script can carry current settings.
   */
  injectScript?: string | (() => string);
  /** Called for every event posted by the injected controller. */
  onEvent?: (event: { name: string; data: unknown }) => void;
}

/** Which hosts a given provider partition may navigate/popup to. */
function hostAllowedFor(partition: string, hostname: string): boolean {
  if (partition.includes("apple")) {
    return hostname.endsWith(".apple.com") || hostname === "apple.com";
  }
  if (partition.includes("youtube")) {
    return (
      hostname.endsWith(".youtube.com") ||
      hostname === "youtube.com" ||
      hostname.endsWith(".google.com") ||
      hostname.endsWith(".googleusercontent.com")
    );
  }
  if (partition.includes("spotify")) {
    return hostname.endsWith(".spotify.com") || hostname === "spotify.com";
  }
  return false;
}

/** The page eval exceeded its time budget — the call's fate is unknown. */
export class ProviderEvalTimeout extends Error {
  constructor(partition: string) {
    super(`provider eval timed out on ${partition}`);
    this.name = "ProviderEvalTimeout";
  }
}

export class ProviderSession {
  readonly partition: string;
  private win: BrowserWindow | null = null;
  private listeners = new Set<(e: { name: string; data: unknown }) => void>();
  private readyPromise: Promise<void> | null = null;

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
          // A hidden view gets no user gestures. Electron's default, stated
          // because provider Web Audio graphs depend on it: a context that
          // could not start would silence the element routed into it.
          autoplayPolicy: "no-user-gesture-required",
        },
      });

      // Route provider events posted through the preload bridge — only from
      // frames inside the provider's own host family.
      win.webContents.on("ipc-message", (e, channel, name, data) => {
        if (channel !== "cadence:provider-event") return;
        const frameUrl = e.senderFrame?.url ?? "";
        if (!frameUrl || !hostAllowed(frameUrl)) return;
        const evt = { name: String(name), data };
        for (const l of this.listeners) l(evt);
      });

      // A provider page crashing or being killed is a route-local failure:
      // report it, never take the app down.
      win.webContents.on("render-process-gone", (_e, details) => {
        for (const l of this.listeners)
          l({ name: "viewGone", data: { reason: details.reason } });
      });

      // Re-inject the controller after every (in-page) navigation — SPAs
      // keep JS state, but hard loads (redirects, OAuth round-trips) wipe it.
      if (this.opts.injectScript) {
        const script = this.opts.injectScript;
        win.webContents.on("did-finish-load", () => {
          void win.webContents
            .executeJavaScript(typeof script === "function" ? script() : script, true)
            .catch(() => undefined);
        });
      }

      // Keep the provider page inside its own service: sign-in popups and
      // navigations may only go to the provider's family of hosts.
      const hostAllowed = (raw: string): boolean => {
        try {
          const u = new URL(raw);
          return u.protocol === "https:" && hostAllowedFor(this.partition, u.hostname);
        } catch {
          return false;
        }
      };
      win.webContents.on("will-navigate", (event, url) => {
        if (!hostAllowed(url)) event.preventDefault();
      });
      // Server redirects bypass will-navigate — check those too. A
      // post-redirect landed outside the family gets rolled back.
      win.webContents.on("will-redirect", (event, url) => {
        if (!hostAllowed(url)) event.preventDefault();
      });
      let rollbackCount = 0;
      win.webContents.on("did-navigate", (_e, url) => {
        if (!hostAllowed(url)) {
          if (rollbackCount++ >= 3) return; // offline error pages — don't loop
          setTimeout(() => (rollbackCount = 0), 30_000);
          void win.webContents.loadURL(this.opts.url).catch(() => undefined);
        }
      });
      win.webContents.setWindowOpenHandler(({ url }) => {
        if (!hostAllowed(url)) return { action: "deny" };
        // Provider sign-in popups must open in the same account partition.
        return { action: "allow", overrideBrowserWindowOptions: { show: true } };
      });
      // Sign-in popups get their own windows — keep those inside the
      // provider's hosts too. Recursive: grandchildren get the same guards
      // and the same lifecycle tracking.
      const trackPopup = (win2: BrowserWindow) => {
        this.popups.add(win2);
        for (const l of this.popupOpenedListeners) l();
        win2.on("closed", () => {
          this.popups.delete(win2);
          for (const l of this.popupClosedListeners) l();
        });
      };
      const guardPopup = (wc: WebContents) => {
        wc.on("will-navigate", (event, url) => {
          if (!hostAllowed(url)) event.preventDefault();
        });
        wc.on("will-redirect", (event, url) => {
          if (!hostAllowed(url)) event.preventDefault();
        });
        wc.setWindowOpenHandler(({ url }) =>
          hostAllowed(url)
            ? { action: "allow", overrideBrowserWindowOptions: { show: true } }
            : { action: "deny" },
        );
        wc.on("did-create-window", (grand) => {
          guardPopup(grand.webContents);
          trackPopup(grand);
        });
      };
      win.webContents.on("did-create-window", (child) => {
        guardPopup(child.webContents);
        trackPopup(child);
      });

      // Assign before loadURL: reveal() and eval() see the window even while
      // the page is still loading (or the load fails). A reset() during the
      // load must not let the stale attempt overwrite the fresh state.
      const attempt = { win };
      this.win = win;
      try {
        await win.loadURL(this.opts.url);
      } catch (e) {
        // Don't leak the failed hidden window — destroy so a retry starts clean.
        if (this.win === attempt.win) this.win = null;
        if (!win.isDestroyed()) win.destroy();
        throw e;
      }
    })();

    const pending = this.readyPromise;
    try {
      await pending;
    } finally {
      if (this.readyPromise === pending) this.readyPromise = null;
    }
  }

  /** Run a command inside the page world. Serialized + validated strings only. */
  async eval<T = unknown>(expression: string, timeoutMs = 10_000): Promise<T> {
    if (!this.alive) throw new Error(`provider session ${this.partition} is not alive`);
    // A wedged provider page must not stall the coordinator chain.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.win!.webContents.executeJavaScript(expression, true),
        new Promise<never>((_, rej) => {
          timer = setTimeout(
            () => rej(new ProviderEvalTimeout(this.partition)),
            timeoutMs,
          );
        }),
      ]);
      return result as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Destroy the view and drop the pending-load promise — used on sign-out so
   * the live in-page instance (and its MusicKit auth) is fully gone.
   */
  reset(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.destroyPopups();
    this.win = null;
    this.readyPromise = null;
  }

  /** Popups outlive the parent — an auth window surviving teardown could
   * re-seed auth into a wiped partition. Every teardown path kills them. */
  private destroyPopups(): void {
    for (const p of this.popups) {
      if (!p.isDestroyed()) p.destroy();
    }
    this.popups.clear();
  }

  onEvent(cb: (e: { name: string; data: unknown }) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private popupClosedListeners = new Set<() => void>();
  private popupOpenedListeners = new Set<() => void>();
  /** Live popup windows (sign-in flows) this view spawned. */
  private popups = new Set<BrowserWindow>();

  /** Popup windows this session's view spawned (sign-in flows) closing. */
  onPopupClosed(cb: () => void): () => void {
    this.popupClosedListeners.add(cb);
    return () => this.popupClosedListeners.delete(cb);
  }

  /** A provider popup window was created — a sign-in flow became visible. */
  onPopupOpened(cb: () => void): () => void {
    this.popupOpenedListeners.add(cb);
    return () => this.popupOpenedListeners.delete(cb);
  }

  /** Whether a provider popup (e.g. the sign-in window) is still open. */
  get hasOpenPopups(): boolean {
    return this.popups.size > 0;
  }

  /** Raise the newest open popup — a sign-in retry should surface it, not
   * the parent view. */
  focusPopup(): boolean {
    const last = [...this.popups].at(-1);
    if (!last || last.isDestroyed()) return false;
    last.show();
    last.focus();
    return true;
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

  /** Cheap signal that the partition likely holds a signed-in session —
   * looks for Apple's media-user-token specifically (a signed-out visit
   * still leaves anonymous cookies). */
  async hasSessionCookies(): Promise<boolean> {
    try {
      const ses = session.fromPartition(this.partition);
      const cookies = await ses.cookies.get({ url: this.opts.url });
      return cookies.some((c) => /media-user-token|media_user_token/.test(c.name));
    } catch {
      return false;
    }
  }

  /** Destroy the view. The session partition (and login) persists. */
  async release(): Promise<void> {
    // Popups die even when the parent is already gone — a dead view's
    // auth window must not linger.
    this.destroyPopups();
    if (!this.alive) return;
    const win = this.win!;
    this.win = null;
    if (!win.isDestroyed()) win.destroy();
  }

  async dispose(): Promise<void> {
    await this.release();
    this.destroyPopups();
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

  /** Wipe the partition's storage — full provider sign-out. Throws on
   * failure: callers must not report a clean sign-out they can't confirm. */
  async clearData(): Promise<void> {
    await session.fromPartition(this.partition).clearStorageData();
  }
}
