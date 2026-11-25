/**
 * The Apple sign-in loop: MusicKit's authorize() leaves the user token on
 * Apple's auth hosts only, while a fresh music.apple.com page restores login
 * solely from its own `media-user-token` cookie — so every reload came back
 * signed out. And closing the revealed sign-in window destroyed the playback
 * view, after which a sign-in timer crashed calling hide() on it.
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Cookie {
  name: string;
  domain: string;
  value: string;
  expirationDate?: number;
}

const jar: Cookie[] = [];
const appEvents = new EventEmitter();

class FakeWindow extends EventEmitter {
  static last: FakeWindow | null = null;
  destroyed = false;
  visible = false;
  webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => this.destroyed,
    setWindowOpenHandler: () => {},
    executeJavaScript: async () => true,
    setAudioMuted: () => {},
  });
  constructor() {
    super();
    FakeWindow.last = this;
  }
  async loadURL(): Promise<void> {}
  isDestroyed(): boolean {
    return this.destroyed;
  }
  show(): void {
    if (this.destroyed) throw new TypeError("Object has been destroyed");
    this.visible = true;
  }
  focus(): void {
    if (this.destroyed) throw new TypeError("Object has been destroyed");
  }
  hide(): void {
    if (this.destroyed) throw new TypeError("Object has been destroyed");
    this.visible = false;
  }
  /** What the OS close button does: 'close' (cancelable), then destroy. */
  userClose(): void {
    let prevented = false;
    this.emit("close", { preventDefault: () => (prevented = true) });
    if (!prevented) this.destroy();
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("closed");
  }
}

vi.mock("electron", () => ({
  app: { on: (ev: string, cb: () => void) => appEvents.on(ev, cb) },
  BrowserWindow: FakeWindow,
  webContents: {},
  session: {
    fromPartition: () => ({
      cookies: {
        get: async (filter: { name?: string; url?: string }) =>
          jar.filter(
            (c) =>
              (filter.name === undefined || c.name === filter.name) &&
              (filter.url === undefined || new URL(filter.url).hostname.endsWith(c.domain.replace(/^\./, ""))),
          ),
        set: async (c: Cookie & { url: string }) => {
          const i = jar.findIndex((x) => x.name === c.name && x.domain === c.domain);
          const next = { name: c.name, domain: c.domain, value: c.value, ...(c.expirationDate ? { expirationDate: c.expirationDate } : {}) };
          if (i >= 0) jar[i] = next;
          else jar.push(next);
        },
      },
      clearStorageData: async () => {
        jar.length = 0;
      },
    }),
  },
}));

const { ProviderSession } = await import("../src/adapters/providers/provider-session.js");
const { AppleMusicKitAdapter } = await import("../src/adapters/providers/apple-musickit.js");

const HOSTS = [".authorize.music.apple.com", ".mediaauth.apple.com"];
const newSession = () => new ProviderSession({ partition: "persist:provider-apple", url: "https://music.apple.com/us/browse" });

beforeEach(() => {
  jar.length = 0;
});

describe("promoteCookie", () => {
  it("copies the sign-in token onto the page's domain, keeping its expiry", async () => {
    jar.push({ name: "media-user-token", domain: ".authorize.music.apple.com", value: "T1", expirationDate: 1_900_000_000 });
    const s = newSession();
    expect(await s.hasSessionCookies()).toBe(false);
    expect(await s.promoteCookie("media-user-token", HOSTS, ".music.apple.com")).toBe(true);
    expect(jar.find((c) => c.domain === ".music.apple.com")).toEqual({
      name: "media-user-token",
      domain: ".music.apple.com",
      value: "T1",
      expirationDate: 1_900_000_000,
    });
    expect(await s.hasSessionCookies()).toBe(true);
  });

  it("is a no-op when the page already holds the same token", async () => {
    jar.push({ name: "media-user-token", domain: ".authorize.music.apple.com", value: "T1" });
    jar.push({ name: "media-user-token", domain: ".music.apple.com", value: "T1" });
    expect(await newSession().promoteCookie("media-user-token", HOSTS, ".music.apple.com")).toBe(false);
  });

  it("replaces a stale page token after a new sign-in", async () => {
    jar.push({ name: "media-user-token", domain: ".authorize.music.apple.com", value: "NEW" });
    jar.push({ name: "media-user-token", domain: ".music.apple.com", value: "OLD" });
    expect(await newSession().promoteCookie("media-user-token", HOSTS, ".music.apple.com")).toBe(true);
    expect(jar.find((c) => c.domain === ".music.apple.com")?.value).toBe("NEW");
  });

  it("falls back to the media-auth host, and does nothing when signed out", async () => {
    const s = newSession();
    expect(await s.promoteCookie("media-user-token", HOSTS, ".music.apple.com")).toBe(false);
    expect(jar).toEqual([]);
    jar.push({ name: "media-user-token", domain: ".mediaauth.apple.com", value: "M" });
    expect(await s.promoteCookie("media-user-token", HOSTS, ".music.apple.com")).toBe(true);
    expect(jar.find((c) => c.domain === ".music.apple.com")?.value).toBe("M");
  });
});

it("a sign-out during a promotion leaves no token behind", async () => {
  jar.push({ name: "media-user-token", domain: ".authorize.music.apple.com", value: "T1" });
  const s = newSession();
  const promoted = s.promoteCookie("media-user-token", HOSTS, ".music.apple.com");
  await s.clearData();
  await promoted;
  expect(jar).toEqual([]);
});

describe("the revealed provider window", () => {
  it("closing it hides the playback view instead of destroying it", async () => {
    const s = newSession();
    await s.prepare();
    const win = FakeWindow.last!;
    s.reveal();
    expect(win.visible).toBe(true);
    win.userClose();
    expect(win.destroyed).toBe(false);
    expect(win.visible).toBe(false);
    expect(s.alive).toBe(true);
  });

  it("still closes when the app quits", async () => {
    const s = newSession();
    await s.prepare();
    const win = FakeWindow.last!;
    appEvents.emit("before-quit");
    win.userClose();
    expect(win.destroyed).toBe(true);
    expect(s.alive).toBe(false);
  });

  it("hide() and reveal() on a destroyed window do not throw, and prepare() rebuilds", async () => {
    const s = newSession();
    await s.prepare();
    const first = FakeWindow.last!;
    first.destroy(); // e.g. the window went away underneath a pending timer
    expect(() => s.hide()).not.toThrow();
    expect(() => s.reveal()).not.toThrow();
    expect(s.alive).toBe(false);
    await s.prepare();
    expect(FakeWindow.last).not.toBe(first);
    expect(s.alive).toBe(true);
  });
});

describe("Apple adapter keeps the login restorable", () => {
  function adapterWith(session: Record<string, unknown>) {
    const a = new AppleMusicKitAdapter();
    Object.assign(a, { session });
    return a;
  }

  it("promotes the token before a fresh view loads, and reinstalls the controller", async () => {
    const order: string[] = [];
    let alive = false;
    const a = adapterWith({
      get alive() {
        return alive;
      },
      promoteCookie: async () => {
        order.push("promote");
        return true;
      },
      prepare: async () => {
        order.push("load page");
        alive = true;
      },
      eval: async (expr: string) => {
        order.push(expr.includes("__cadenceAudioConfig") ? "install controller" : "eval");
        return true;
      },
    });
    Object.assign(a, { installed: true }); // stale from a view that is now gone
    await (a as unknown as { ensureSession(): Promise<void> }).ensureSession();
    expect(order.slice(0, 3)).toEqual(["promote", "load page", "install controller"]);
  });

  it("persists the login as soon as the page reports authorization", async () => {
    const promote = vi.fn(async () => true);
    const a = adapterWith({ alive: true, promoteCookie: promote, hide: () => {} });
    (a as unknown as { onPageEvent(n: string, d: unknown): void }).onPageEvent("playerState", { state: "none", isAuthorized: true });
    await Promise.resolve();
    expect(promote).toHaveBeenCalledWith("media-user-token", HOSTS, ".music.apple.com");
  });

  it("restores the login before reporting launch capabilities", async () => {
    jar.push({ name: "media-user-token", domain: ".authorize.music.apple.com", value: "T" });
    const real = newSession();
    const a = adapterWith({
      alive: false,
      promoteCookie: real.promoteCookie.bind(real),
      hasSessionCookies: real.hasSessionCookies.bind(real),
    });
    const caps = await a.capabilities();
    expect(caps.state).toBe("ready");
    expect(caps.playback.canPlay).toBe(true);
  });

  it("never restores a login after sign-out", async () => {
    const promote = vi.fn(async () => true);
    const a = adapterWith({ alive: false, promoteCookie: promote, hasSessionCookies: async () => false });
    Object.assign(a, { signedOut: true });
    await a.capabilities();
    expect(promote).not.toHaveBeenCalled();
  });
});
