import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { MUSICKIT_CONTROLLER_JS } from "../src/adapters/providers/inject/musickit-controller.js";

type Call = { api: string } | { setQueue: true; previewOnly: boolean; storefront: string }
  | { seek: number } | { play: true } | { pause: true };
type Item = { id: string; attributes: { durationInMillis: number }; playParams: { kind: string } };
interface Controller {
  play(spec: { type: "song" | "station"; id: string }, positionMs: number): Promise<boolean>;
  resume(): Promise<boolean>;
  state(): boolean;
  storefront(): Promise<string>;
}

// Execute the shipped injection string in a page-shaped VM. The fake SDK
// deliberately starts in the same preview/US mode observed on Apple's site.
async function harness(options: { authorized?: boolean; subscription?: boolean } = {}) {
  const calls: Call[] = [];
  const events: { name: string; data: Record<string, unknown> }[] = [];
  const listeners = new Map<string, () => void>();
  const mk = {
    isAuthorized: options.authorized ?? true,
    previewOnly: true,
    musicUserToken: "test-account-token",
    storefrontId: "us",
    hasMusicSubscription: async () => options.subscription ?? true,
    playbackState: 0,
    currentPlaybackTime: 0,
    currentPlaybackDuration: 0,
    nowPlayingItem: null as Item | null,
    queue: { items: [] as { id: string }[], position: -1 },
    addEventListener: (name: string, cb: () => void) => listeners.set(name, cb),
    api: {
      music: async (path: string) => {
        calls.push({ api: path });
        return { data: [{ id: "in", type: "storefronts" }] };
      },
    },
    setQueue: async () => {
      calls.push({ setQueue: true, previewOnly: mk.previewOnly, storefront: mk.storefrontId });
      mk.nowPlayingItem = { id: "s1", attributes: { durationInMillis: 249668 }, playParams: { kind: "song" } };
      mk.currentPlaybackTime = 42;
      mk.currentPlaybackDuration = mk.previewOnly ? 90 : 249.668;
    },
    seekToTime: async (time: number) => { calls.push({ seek: time }); mk.currentPlaybackTime = time; },
    play: async () => { calls.push({ play: true }); mk.playbackState = 2; },
    pause: () => { calls.push({ pause: true }); mk.playbackState = 3; },
  };
  const window: {
    MusicKit: { getInstance(): typeof mk; Events: Record<string, string>; PlaybackStates: Record<string, number> };
    __cadenceBridge: { emit(name: string, data: Record<string, unknown>): void };
    __cadenceCtl?: Controller;
  } = {
    MusicKit: {
      getInstance: () => mk,
      Events: { authorizationStatusDidChange: "authorizationStatusDidChange" },
      PlaybackStates: { none: 0, loading: 1, playing: 2, paused: 3, stopped: 4, ended: 5, seeking: 6, waiting: 8, stalled: 9, completed: 10 },
    },
    __cadenceBridge: { emit: (name, data) => events.push({ name, data }) },
  };
  await runInNewContext(MUSICKIT_CONTROLLER_JS, { window, setInterval: () => 1, setTimeout });
  if (!window.__cadenceCtl) throw new Error("Controller did not install");
  return { ctl: window.__cadenceCtl, mk, calls, events, listeners };
}

const song = { type: "song", id: "s1" } as const;

describe("real injected MusicKit controller", () => {
  it("pauses the old stream before waiting for subscription checks or the new queue", async () => {
    const { ctl, mk, calls } = await harness();
    mk.playbackState = 2;
    let release: (value: boolean) => void = () => {};
    mk.hasMusicSubscription = () => new Promise(resolve => { release = resolve; });
    const switching = ctl.play(song, 0);
    const stateBeforeNetwork = mk.playbackState;
    for (let i = 0; i < 5; i++) await Promise.resolve();
    release(true);
    await switching;
    expect(stateBeforeNetwork).toBe(3);
    expect(calls[0]).toEqual({ pause: true });
  });

  it("does not seek again when the new stream is already at zero", async () => {
    const { ctl, mk, calls } = await harness();
    const load = mk.setQueue;
    mk.setQueue = async () => { await load(); mk.currentPlaybackTime = 0; };
    await ctl.play(song, 0);
    expect(calls.some(c => "seek" in c)).toBe(false);
  });

  it("uses the subscriber's storefront and full playback rather than the site's preview default", async () => {
    const { ctl, mk, calls } = await harness();
    await ctl.play(song, 0);
    expect(calls).toContainEqual({ setQueue: true, previewOnly: false, storefront: "in" });
    expect(mk.currentPlaybackDuration).toBe(249.668);
  });

  it("starts a newly selected song at zero even when MusicKit retains the old time", async () => {
    const { ctl, mk } = await harness();
    await ctl.play(song, 0);
    expect(mk.currentPlaybackTime).toBe(0);
  });

  it("restores a saved position after the new stream starts", async () => {
    const { ctl, mk, calls } = await harness();
    await ctl.play(song, 120_000);
    expect(mk.currentPlaybackTime).toBe(120);
    expect(calls.slice(-2)).toEqual([{ play: true }, { seek: 120 }]);
  });

  it("does not seek a live station", async () => {
    const { ctl, calls } = await harness();
    await ctl.play({ type: "station", id: "station" }, 0);
    expect(calls.some(c => "seek" in c)).toBe(false);
  });

  it("refuses anonymous preview playback before creating a queue", async () => {
    const { ctl, calls } = await harness({ authorized: false });
    await expect(ctl.play(song, 0)).rejects.toThrow(/sign in/i);
    expect(calls.some(c => "setQueue" in c)).toBe(false);
  });

  it("refuses preview playback for an account without a subscription", async () => {
    const { ctl, calls } = await harness({ subscription: false });
    await expect(ctl.play(song, 0)).rejects.toThrow(/subscription/i);
    expect(calls.some(c => "setQueue" in c)).toBe(false);
  });

  it("rechecks authorization before resuming", async () => {
    const { ctl, mk, calls } = await harness();
    await ctl.play(song, 0);
    mk.isAuthorized = false;
    calls.length = 0;
    await expect(ctl.resume()).rejects.toThrow(/sign in/i);
    expect(calls).toEqual([]);
  });

  it("refreshes the account region when the account token changes", async () => {
    const { ctl, mk, calls } = await harness();
    await ctl.storefront();
    await ctl.storefront();
    expect(calls).toHaveLength(1);
    mk.musicUserToken = "another-test-account";
    await ctl.storefront();
    expect(calls).toHaveLength(2);
  });

  it("does not report a 90-second preview boundary as the end of a four-minute song", async () => {
    const { ctl, mk, events } = await harness();
    mk.nowPlayingItem = { id: "s1", attributes: { durationInMillis: 249668 }, playParams: { kind: "song" } };
    mk.currentPlaybackDuration = 90;
    mk.currentPlaybackTime = 90;
    mk.playbackState = 5;
    ctl.state();
    expect(events.filter(e => e.name === "playerState").at(-1)?.data.ended).toBe(false);
    expect(events.some(e => e.name === "error" && /preview/i.test(String(e.data.message)))).toBe(true);
  });

  it("reports the actual full-track end and ignores a transient stopped state", async () => {
    const { ctl, mk, events } = await harness();
    await ctl.play(song, 0);
    mk.playbackState = 4;
    ctl.state();
    expect(events.filter(e => e.name === "playerState").at(-1)?.data.ended).toBe(false);
    mk.currentPlaybackTime = 249.668;
    mk.playbackState = 10;
    ctl.state();
    expect(events.filter(e => e.name === "playerState").at(-1)?.data.ended).toBe(true);
  });
});
