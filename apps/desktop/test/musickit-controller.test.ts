import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { MUSICKIT_CONTROLLER_JS } from "../src/adapters/providers/inject/musickit-controller.js";

type Call = { api: string } | { setQueue: true; previewOnly: boolean; storefront: string }
  | { seek: number } | { play: true } | { pause: true };
type Item = { id: string; attributes: { durationInMillis: number }; playParams: { kind: string } };
interface Controller {
  play(spec: { type: "song" | "station"; id: string }, positionMs: number): Promise<boolean>;
  resume(): Promise<boolean>;
  setVolume(volume: number): boolean;
  state(): boolean;
  storefront(): Promise<string>;
}

// Execute the shipped injection string in a page-shaped VM. The fake SDK
// deliberately starts in the same preview/US mode observed on Apple's site.
async function harness(options: { authorized?: boolean; subscription?: boolean; configureFallback?: boolean; initialVolume?: number } = {}) {
  const calls: Call[] = [];
  const events: { name: string; data: Record<string, unknown> }[] = [];
  const listeners = new Map<string, () => void>();
  const configurations: { bitrate?: number }[] = [];
  const mk = {
    volume: options.initialVolume ?? 1,
    bitrate: 64,
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
    MusicKit: {
      getInstance(): typeof mk | null;
      configure(config: { bitrate?: number }): typeof mk;
      PlaybackBitrate: { HIGH: number; STANDARD: number };
      Events: Record<string, string>;
      PlaybackStates: Record<string, number>;
    };
    __cadenceBridge: { emit(name: string, data: Record<string, unknown>): void };
    __cadenceCtl?: Controller;
  } = {
    MusicKit: {
      getInstance: () => options.configureFallback ? null : mk,
      configure: config => { configurations.push(config); return mk; },
      PlaybackBitrate: { HIGH: 256, STANDARD: 64 },
      Events: { authorizationStatusDidChange: "authorizationStatusDidChange" },
      PlaybackStates: { none: 0, loading: 1, playing: 2, paused: 3, stopped: 4, ended: 5, seeking: 6, waiting: 8, stalled: 9, completed: 10 },
    },
    __cadenceBridge: { emit: (name, data) => events.push({ name, data }) },
  };
  await runInNewContext(MUSICKIT_CONTROLLER_JS, {
    window,
    document: {
      scripts: [{ id: "serialized-server-data", type: "application/json", textContent: '{"token":"eyJtest-only-token"}' }],
      documentElement: { innerHTML: "" },
    },
    setInterval: () => 1,
    setTimeout: options.configureFallback ? (fn: () => void) => { fn(); return 1; } : setTimeout,
  });
  if (!window.__cadenceCtl) throw new Error("Controller did not install");
  return { ctl: window.__cadenceCtl, mk, calls, events, listeners, configurations };
}

const song = { type: "song", id: "s1" } as const;

describe("real injected MusicKit controller", () => {
  it("requests high bitrate before loading and resuming songs", async () => {
    const { ctl, mk } = await harness();
    expect(mk.bitrate).toBe(256);
    mk.bitrate = 64;
    let queuedBitrate = 0;
    const load = mk.setQueue;
    mk.setQueue = async () => { queuedBitrate = mk.bitrate; await load(); };
    await ctl.play(song, 0);
    expect(queuedBitrate).toBe(256);
    mk.bitrate = 64;
    await ctl.resume();
    expect(mk.bitrate).toBe(256);
  });

  it("includes high bitrate when configuring the fallback SDK instance", async () => {
    const { configurations } = await harness({ configureFallback: true });
    expect(configurations).toHaveLength(1);
    expect(configurations[0]?.bitrate).toBe(256);
  });

  it("keeps a constant output margin and linear volume without dynamic gain", async () => {
    const { ctl, mk } = await harness();
    ctl.setVolume(1);
    const full = mk.volume;
    expect(full).toBeCloseTo(0.7943282347, 9);
    ctl.setVolume(.5);
    expect(mk.volume).toBe(full * .5);
    ctl.setVolume(0);
    expect(mk.volume).toBe(0);
    ctl.setVolume(1.5);
    expect(mk.volume).toBe(full);
  });

  it("retains requested volume if MusicKit resets its level while loading", async () => {
    const { ctl, mk } = await harness();
    ctl.setVolume(.5);
    const wanted = mk.volume;
    const play = mk.play;
    mk.play = async () => { mk.volume = 1; await play(); };
    await ctl.play(song, 0);
    expect(mk.volume).toBe(wanted);
    await ctl.resume();
    expect(mk.volume).toBe(wanted);
  });

  it("applies the requested level before playback starts after a queue reset", async () => {
    for (const volume of [0, .5, 1]) {
      const { ctl, mk } = await harness();
      ctl.setVolume(volume);
      const wanted = mk.volume;
      const levelsAtStart: number[] = [];
      const load = mk.setQueue;
      mk.setQueue = async () => { await load(); mk.volume = 1; };
      const play = mk.play;
      mk.play = async () => { levelsAtStart.push(mk.volume); await play(); };
      await ctl.play(song, 0);
      mk.volume = 1;
      await ctl.resume();
      expect(levelsAtStart).toEqual([wanted, wanted]);
    }
  });

  it("uses a safe default for an invalid SDK volume while preserving mute", async () => {
    const invalid = await harness({ initialVolume: Number.NaN });
    await invalid.ctl.play(song, 0);
    expect(invalid.mk.volume).toBeCloseTo(0.7943282347, 9);
    const muted = await harness({ initialVolume: 0 });
    await muted.ctl.play(song, 0);
    expect(muted.mk.volume).toBe(0);
  });

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
