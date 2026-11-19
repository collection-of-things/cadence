import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { YTM_CONTROLLER_JS } from "../src/adapters/providers/inject/ytm-controller.js";
import { accountKey } from "../src/adapters/providers/youtube-music-catalog.js";

interface PlayerState {
  state: string;
  generationId: number | null;
  positionMs: number;
  durationMs: number;
  videoId: string | null;
  expectedVideoId: string | null;
  ad: boolean;
}
interface Controller {
  bootId: string;
  play(videoId: string, positionMs: number, generationId: number, volume: number): Promise<string | PlayerState>;
  pause(): boolean;
  stop(): boolean;
  seek(ms: number): boolean;
  isSignedIn(): boolean | null;
  getState(): PlayerState;
}

class FakeMedia {
  paused = true;
  ended = false;
  currentTime = 0;
  duration = 200;
  readyState = 4;
  volume = 1;
  volumeAtPlay = 1;
  constructor(private fire: (type: string, target: unknown) => void) {}
  async play(): Promise<void> {
    this.volumeAtPlay = this.volume;
    this.paused = false;
    this.ended = false;
    this.fire("play", this);
  }
  pause(): void {
    this.paused = true;
    this.fire("pause", this);
  }
}

/** Minimal music.youtube.com stand-in: one <video>, #movie_player, SPA router. */
function fakePage(opts: { routerWorks?: boolean; ytcfg?: Record<string, unknown> } = {}) {
  const listeners = new Map<string, ((e: { target: unknown }) => void)[]>();
  const fire = (type: string, target: unknown): void => {
    for (const fn of listeners.get(type) ?? []) fn({ target });
  };
  const video = new FakeMedia(fire);
  let id = "A";
  const classes = new Set<string>();
  const stateListeners: ((s: number) => void)[] = [];
  const player = {
    classList: { contains: (c: string) => classes.has(c) },
    getVideoData: () => ({ video_id: id }),
    seekTo: (s: number) => { video.currentTime = s; },
    addEventListener: (name: string, fn: (s: number) => void) => { if (name === "onStateChange") stateListeners.push(fn); },
  };
  const app = {
    dispatchEvent: (e: { detail: { endpoint: { watchEndpoint: { videoId: string } } } }) => {
      if (opts.routerWorks !== false) id = e.detail.endpoint.watchEndpoint.videoId;
      return true;
    },
  };
  const assigned: string[] = [];
  const emits: PlayerState[] = [];
  let now = 0;
  const intervals: (() => void)[] = [];
  const context = {
    window: {} as Record<string, unknown>,
    document: {
      querySelector: (sel: string) =>
        sel === "video" ? video : sel === "#movie_player" ? player : sel === "ytmusic-app" ? app : null,
      addEventListener: (type: string, fn: (e: { target: unknown }) => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      },
    },
    location: {
      get href() { return `https://music.youtube.com/watch?v=${id}`; },
      assign: (url: string) => { assigned.push(url); },
    },
    HTMLMediaElement: FakeMedia,
    CustomEvent: class { constructor(public type: string, init: { detail: unknown }) { Object.assign(this, init); } },
    URL,
    Date: { now: () => now },
    // Timers advance a fake clock so waitFor deadlines don't cost real time.
    setTimeout: (fn: () => void, ms: number) => { now += ms; queueMicrotask(fn); return 0; },
    setInterval: (fn: () => void) => { intervals.push(fn); return 0; },
  };
  context.window.__cadenceBridge = { emit: (_n: string, d: PlayerState) => emits.push(d) };
  if (opts.ytcfg) context.window.ytcfg = { get: (k: string) => opts.ytcfg![k] };
  runInNewContext(YTM_CONTROLLER_JS, context);
  return {
    ctl: context.window.__cadenceCtl as Controller,
    video,
    emits,
    assigned,
    tick: () => intervals.forEach((fn) => fn()),
    fire,
    setId: (next: string) => { id = next; },
    setAd: (on: boolean) => { if (on) classes.add("ad-showing"); else classes.delete("ad-showing"); },
    stateChange: (s: number) => stateListeners.forEach((fn) => fn(s)),
    endedCount: () => emits.filter((e, i) => e.state === "ended" && emits[i - 1]?.state !== "ended").length,
  };
}

describe("ytm-controller", () => {
  it("reads sign-in from the page config, unknown when absent", () => {
    expect(fakePage({ ytcfg: { LOGGED_IN: false } }).ctl.isSignedIn()).toBe(false);
    expect(fakePage({ ytcfg: { LOGGED_IN: true } }).ctl.isSignedIn()).toBe(true);
    expect(fakePage().ctl.isSignedIn()).toBeNull();
  });

  it("navigates through the SPA router without reloading", async () => {
    const page = fakePage();
    expect(await page.ctl.play("B", 0, 1, 1)).toMatchObject({ state: "playing" });
    expect(page.assigned).toEqual([]);
    expect(page.ctl.getState()).toMatchObject({ state: "playing", videoId: "B", expectedVideoId: "B" });
  });

  it("falls back to a full load when the router does not move", async () => {
    const page = fakePage({ routerWorks: false });
    expect(await page.ctl.play("B", 0, 1, 1)).toBe("reloading");
    expect(page.assigned).toEqual(["https://music.youtube.com/watch?v=B"]);
  });

  it("ignores the outgoing track ending during a delayed SPA switch", async () => {
    const page = fakePage({ routerWorks: false });
    await page.ctl.play("A", 0, 1, 1);
    const switching = page.ctl.play("B", 0, 2, 1);
    page.video.currentTime = 199.5;
    page.tick();
    page.video.ended = true;
    page.fire("ended", page.video);
    page.stateChange(0);
    page.setId("B");
    page.video.currentTime = 0;
    await switching;

    expect(page.video.paused).toBe(false);
    expect(page.ctl.getState()).toMatchObject({ state: "playing", videoId: "B", generationId: 2 });
    expect(page.endedCount()).toBe(0);
  });

  it("sets the requested volume before a fresh document starts playback", async () => {
    const page = fakePage();
    await page.ctl.play("A", 0, 1, 0);
    expect(page.video.volumeAtPlay).toBe(0);
  });

  it("does not start a track whose pending navigation was stopped", async () => {
    const page = fakePage({ routerWorks: false });
    const switching = page.ctl.play("B", 0, 1, 1);
    page.ctl.stop();
    page.setId("B");
    expect(await switching).toBe("superseded");
    expect(page.video.paused).toBe(true);
  });

  it("reports a natural end once and holds the site's autoplay", async () => {
    const page = fakePage();
    await page.ctl.play("A", 0, 1, 1);
    page.video.currentTime = 199.5;
    page.tick();
    page.video.ended = true;
    page.fire("ended", page.video);
    // Site autoplay moves on to its own pick.
    page.setId("RADIO");
    await page.video.play();
    page.stateChange(0);
    page.tick();
    expect(page.video.paused).toBe(true);
    expect(page.ctl.getState().state).toBe("ended");
    expect(page.endedCount()).toBe(1);

    expect(await page.ctl.play("B", 0, 2, 1)).toMatchObject({ state: "playing" });
    expect(page.video.paused).toBe(false);
    expect(page.ctl.getState().state).toBe("playing");
  });

  it("treats a track change near the end as autoplay, mid-track as a redirect", async () => {
    const page = fakePage();
    await page.ctl.play("A", 0, 1, 1);
    page.video.currentTime = 60;
    page.tick();
    page.setId("A2");
    page.tick();
    expect(page.ctl.getState()).toMatchObject({ state: "playing", expectedVideoId: "A2" });
    expect(page.endedCount()).toBe(0);

    page.video.currentTime = 198;
    page.tick();
    page.setId("RADIO");
    page.tick();
    expect(page.endedCount()).toBe(1);
    expect(page.video.paused).toBe(true);
  });

  it("keeps ads out of the track's position and duration", async () => {
    const page = fakePage();
    await page.ctl.play("A", 0, 1, 1);
    page.video.currentTime = 42;
    page.tick();
    page.setAd(true);
    page.video.currentTime = 3;
    page.video.duration = 15;
    expect(page.ctl.getState()).toMatchObject({ state: "buffering", ad: true, positionMs: 42_000, durationMs: 200_000, videoId: "A" });
  });

  it("does not post while paused and unchanged", async () => {
    const page = fakePage();
    await page.ctl.play("A", 0, 1, 1);
    page.ctl.pause();
    const n = page.emits.length;
    page.tick();
    page.tick();
    expect(page.emits.length).toBe(n);
  });
});

describe("youtube-music-catalog accountKey", () => {
  it("keys on the Google account cookie, ignoring rotating cookies", () => {
    expect(accountKey(undefined)).toBe("");
    expect(accountKey("YSC=abc; VISITOR_INFO1_LIVE=x")).toBe("");
    expect(accountKey("YSC=abc; SAPISID=acct1/xyz; PREF=f6")).toBe("acct1/xyz");
    expect(accountKey("__Secure-3PAPISID=acct2; YSC=rotated")).toBe("acct2");
  });
});
