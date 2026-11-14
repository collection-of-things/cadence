import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  MUSICKIT_CONTROLLER_JS,
  musickitInjectScript,
  type MusicKitAudioConfig,
} from "../src/adapters/providers/inject/musickit-controller.js";

type Call = { api: string } | { setQueue: true; previewOnly: boolean; storefront: string }
  | { seek: number } | { play: true } | { pause: true };
type Item = { id: string; attributes: { durationInMillis: number }; playParams: { kind: string } };
interface Controller {
  play(spec: { type: "song" | "station"; id: string }, positionMs: number): Promise<boolean>;
  resume(): Promise<boolean>;
  setVolume(volume: number): boolean;
  setEq(bands: { freqHz: number; gainDb: number }[]): boolean;
  state(): boolean;
  storefront(): Promise<string>;
}

// Web Audio fakes record the node graph so tests can walk the real routes.
class FakeParam {
  ramps: number[] = [];
  constructor(public value: number) {}
  cancelScheduledValues(): void {}
  cancelAndHoldAtTime(): void {}
  setValueAtTime(value: number): void { this.value = value; }
  linearRampToValueAtTime(value: number): void { this.value = value; this.ramps.push(value); }
}
class FakeNode {
  outputs = new Set<FakeNode>();
  constructor(public kind: string) {}
  connect(node: FakeNode): FakeNode { this.outputs.add(node); return node; }
  disconnect(node?: FakeNode): void { if (node === undefined) this.outputs.clear(); else this.outputs.delete(node); }
}
class FakeGain extends FakeNode { gain = new FakeParam(1); constructor() { super("gain"); } }
class FakeBiquad extends FakeNode {
  type = "lowpass";
  frequency = new FakeParam(350);
  Q = new FakeParam(1);
  gain = new FakeParam(0);
  constructor() { super("biquad"); }
}
type Element = { currentSrc: string };
interface AudioFaults { suspended?: boolean; resumeFails?: boolean; throwOnCreate?: boolean; throwOnSource?: boolean }

function fakeWebAudio(faults: AudioFaults) {
  const contexts: FakeContext[] = [];
  const constructorArgs: unknown[][] = [];
  class FakeContext {
    sampleRate = 48000;
    state = "running";
    currentTime = 0;
    destination = new FakeNode("destination");
    sources: { element: Element; node: FakeNode }[] = [];
    biquads: FakeBiquad[] = [];
    constructor(...args: unknown[]) {
      constructorArgs.push(args);
      if (faults.throwOnCreate) throw new Error("no audio device");
      const rate = (args[0] as { sampleRate?: number } | undefined)?.sampleRate;
      if (rate !== undefined) this.sampleRate = rate;
      if (faults.suspended) this.state = "suspended";
      contexts.push(this);
    }
    addEventListener(): void {}
    async resume(): Promise<void> { if (!faults.resumeFails) this.state = "running"; }
    close(): void {}
    createGain(): FakeGain { return new FakeGain(); }
    createBiquadFilter(): FakeBiquad { const b = new FakeBiquad(); this.biquads.push(b); return b; }
    createMediaElementSource(element: Element): FakeNode {
      if (faults.throwOnSource) throw new Error("InvalidStateError: already connected");
      const node = new FakeNode("source");
      this.sources.push({ element, node });
      return node;
    }
  }
  return { AudioContext: FakeContext, contexts, constructorArgs };
}

/** Every route from a node to another, as node lists. */
function routes(from: FakeNode, to: FakeNode): FakeNode[][] {
  if (from === to) return [[to]];
  return [...from.outputs].flatMap(next => routes(next, to).map(r => [from, ...r]));
}
/** Routes that carry sound: no gain node on them is at zero. */
function audibleRoutes(from: FakeNode, to: FakeNode): FakeNode[][] {
  return routes(from, to).filter(r => r.every(n => !(n instanceof FakeGain) || n.gain.value !== 0));
}
const gainOf = (route: FakeNode[]) =>
  route.reduce((g, n) => (n instanceof FakeGain ? g * n.gain.value : g), 1);
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

// Execute the shipped injection string in a page-shaped VM. The fake SDK
// deliberately starts in the same preview/US mode observed on Apple's site.
async function harness(options: {
  authorized?: boolean;
  subscription?: boolean;
  configureFallback?: boolean;
  initialVolume?: number;
  audio?: { config?: Partial<MusicKitAudioConfig>; faults?: AudioFaults; element?: Element | null };
} = {}) {
  const calls: Call[] = [];
  const events: { name: string; data: Record<string, unknown> }[] = [];
  const listeners = new Map<string, () => void>();
  const configurations: { bitrate?: number }[] = [];
  const ticks: (() => void)[] = [];
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
    AudioContext?: unknown;
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
  const webAudio = fakeWebAudio(options.audio?.faults ?? {});
  const player = { element: null as Element | null };
  let script = MUSICKIT_CONTROLLER_JS;
  if (options.audio !== undefined) {
    window.AudioContext = webAudio.AudioContext;
    player.element = options.audio.element === undefined
      ? { currentSrc: "blob:https://music.apple.com/one" } : options.audio.element;
    script = musickitInjectScript({ contextRate: null, eqBands: [], ...options.audio.config });
  }
  await runInNewContext(script, {
    window,
    document: {
      scripts: [{ id: "serialized-server-data", type: "application/json", textContent: '{"token":"eyJtest-only-token"}' }],
      documentElement: { innerHTML: "" },
      getElementById: (id: string) => (id === "apple-music-player" ? player.element : null),
      querySelectorAll: () => [],
    },
    setInterval: (tick: () => void) => { ticks.push(tick); return 1; },
    setTimeout: options.configureFallback ? (fn: () => void) => { fn(); return 1; } : setTimeout,
  });
  if (!window.__cadenceCtl) throw new Error("Controller did not install");
  return {
    ctl: window.__cadenceCtl, mk, calls, events, listeners, configurations, webAudio, player,
    tick: () => ticks.forEach(tick => tick()),
    lastState: () => events.filter(e => e.name === "playerState").at(-1)?.data ?? {},
  };
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
    expect(full).toBeCloseTo(0.8912509381, 9);
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
    expect(invalid.mk.volume).toBeCloseTo(0.8912509381, 9);
    const muted = await harness({ initialVolume: 0 });
    await muted.ctl.play(song, 0);
    expect(muted.mk.volume).toBe(0);
  });

  it("applies volume at install and restores it on state changes and status ticks", async () => {
    const initial = await harness({ initialVolume: .5 });
    expect(initial.mk.volume).toBeCloseTo(.4456254691, 9);
    for (const volume of [0, .5, 1]) {
      const { ctl, mk, listeners, tick } = await harness();
      ctl.setVolume(volume);
      const wanted = mk.volume;
      mk.volume = 1;
      listeners.get("playbackStateDidChange")?.();
      expect(mk.volume).toBe(wanted);
      mk.volume = 1;
      tick();
      expect(mk.volume).toBe(wanted);
    }
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

const EQ_FREQS = [60, 150, 400, 1000, 2400, 6000, 12000, 15000];
const flat = EQ_FREQS.map(freqHz => ({ freqHz, gainDb: 0 }));
const margin = 0.8912509381;

describe("Apple Music Web Audio graph", () => {
  it("leaves MusicKit's element alone until EQ or a context rate is asked for", async () => {
    const { ctl, webAudio, lastState } = await harness({ audio: { config: { eqBands: flat } } });
    await ctl.play(song, 0);
    expect(webAudio.constructorArgs).toEqual([]);
    expect(lastState().audioGraph).toBe("direct");
  });

  it("routes a flat EQ straight through with no filters, at the requested context rate", async () => {
    const { ctl, mk, webAudio, lastState } = await harness({ audio: { config: { contextRate: 96000, eqBands: flat } } });
    await ctl.play(song, 0);
    expect(webAudio.constructorArgs).toEqual([[{ sampleRate: 96000 }]]);
    const ctx = webAudio.contexts[0]!;
    expect(ctx.biquads).toHaveLength(0);
    expect(ctx.sources).toHaveLength(1);
    const paths = audibleRoutes(ctx.sources[0]!.node, ctx.destination);
    expect(paths).toHaveLength(1);
    expect(paths[0]!.every(n => n.kind === "gain" || n.kind === "source" || n.kind === "destination")).toBe(true);
    expect(gainOf(paths[0]!)).toBe(1);
    // The margin stays on the element's volume, as before the graph.
    expect(mk.volume).toBeCloseTo(margin, 9);
    expect(lastState()).toMatchObject({ audioGraph: "attached", contextSampleRateHz: 96000, eqFilters: 0 });
  });

  it("uses the browser's default rate unless one is configured", async () => {
    const { ctl, webAudio } = await harness({ audio: { config: { eqBands: [{ freqHz: 1000, gainDb: 3 }] } } });
    await ctl.play(song, 0);
    expect(webAudio.constructorArgs).toEqual([[]]);
  });

  it("builds one peaking filter per band with the engine's frequency, Q and gain, and pays for boosts", async () => {
    const bands = [{ freqHz: 60, gainDb: 6 }, { freqHz: 1000, gainDb: -3 }, { freqHz: 12000, gainDb: 0.005 }];
    const { ctl, mk, webAudio } = await harness({ audio: { config: { eqBands: bands } } });
    await ctl.play(song, 0);
    const ctx = webAudio.contexts[0]!;
    expect(ctx.biquads.map(b => [b.type, b.frequency.value, b.Q.value, b.gain.value])).toEqual([
      ["peaking", 60, 1, 6], ["peaking", 1000, 1, -3], ["peaking", 12000, 1, 0],
    ]);
    const paths = audibleRoutes(ctx.sources[0]!.node, ctx.destination);
    expect(paths).toHaveLength(1);
    expect(paths[0]!.filter(n => n.kind === "biquad")).toHaveLength(3);
    // The combined curve peaks just under +6 dB at 60 Hz; the trim cuts that much.
    const trimDb = 20 * Math.log10(gainOf(paths[0]!));
    expect(trimDb).toBeLessThan(-5.9);
    expect(trimDb).toBeGreaterThan(-6.05);
    expect(mk.volume).toBeCloseTo(margin, 9);
  });

  it("keeps volume linear and the 1 dB margin with the graph attached", async () => {
    const { ctl, mk, webAudio } = await harness({ audio: { config: { contextRate: 48000 } } });
    await ctl.play(song, 0);
    ctl.setVolume(1);
    const full = mk.volume;
    expect(full).toBeCloseTo(margin, 9);
    ctl.setVolume(.5);
    expect(mk.volume).toBe(full * .5);
    ctl.setVolume(0);
    expect(mk.volume).toBe(0);
    const ctx = webAudio.contexts[0]!;
    expect(gainOf(audibleRoutes(ctx.sources[0]!.node, ctx.destination)[0]!)).toBe(1);
  });

  it("glides live EQ changes without rebuilding or restarting playback, and leaves no filters when flat again", async () => {
    const { ctl, calls, webAudio, lastState } = await harness({ audio: { config: { eqBands: flat } } });
    await ctl.play(song, 0);
    calls.length = 0;
    ctl.setEq(EQ_FREQS.map((freqHz, i) => ({ freqHz, gainDb: i === 0 ? 4 : 0 })));
    await settle();
    const ctx = webAudio.contexts[0]!;
    expect(ctx.biquads).toHaveLength(8);
    ctl.setEq(EQ_FREQS.map((freqHz, i) => ({ freqHz, gainDb: i === 0 ? 2 : 0 })));
    expect(ctx.biquads).toHaveLength(8);
    expect(ctx.biquads[0]!.gain.ramps.at(-1)).toBe(2);
    expect(lastState().eqFilters).toBe(8);
    ctl.setEq([]);
    await new Promise(r => setTimeout(r, 120));
    const paths = routes(ctx.sources[0]!.node, ctx.destination);
    expect(paths).toHaveLength(1);
    expect(paths[0]!.some(n => n.kind === "biquad")).toBe(false);
    expect(gainOf(paths[0]!)).toBe(1);
    expect(calls).toEqual([]);
  });

  it("re-attaches once when MusicKit replaces its element, and never twice", async () => {
    const { ctl, webAudio, player, tick } = await harness({ audio: { config: { eqBands: [{ freqHz: 400, gainDb: 2 }] } } });
    await ctl.play(song, 0);
    const ctx = webAudio.contexts[0]!;
    const first = player.element!;
    expect(ctx.sources.map(s => s.element)).toEqual([first]);
    const second = { currentSrc: "blob:https://music.apple.com/two" };
    player.element = second;
    tick();
    tick();
    expect(ctx.sources.map(s => s.element)).toEqual([first, second]);
    player.element = first;
    tick();
    expect(ctx.sources).toHaveLength(2);
    for (const s of ctx.sources) expect(audibleRoutes(s.node, ctx.destination)).toHaveLength(1);
  });

  it("does not route a cross-origin file, which Web Audio would play as silence", async () => {
    const { ctl, webAudio, lastState } = await harness({
      audio: { config: { contextRate: 96000 }, element: { currentSrc: "https://audio-ssl.itunes.apple.com/preview.m4a" } },
    });
    await ctl.play(song, 0);
    expect(webAudio.contexts[0]!.sources).toHaveLength(0);
    expect(lastState().audioGraph).toBe("waiting");
  });

  it("plays directly and reports an error when the graph cannot be built", async () => {
    const { ctl, mk, calls, events, webAudio, lastState } = await harness({
      audio: { config: { contextRate: 96000 }, faults: { throwOnCreate: true } },
    });
    await ctl.play(song, 0);
    expect(calls).toContainEqual({ play: true });
    expect(mk.volume).toBeCloseTo(margin, 9);
    expect(webAudio.contexts).toHaveLength(0);
    expect(lastState().audioGraph).toBe("failed");
    expect(events.filter(e => e.name === "error").map(e => e.data.message)).toEqual([
      expect.stringMatching(/playing without it.*no audio device/),
    ]);
  });

  it("keeps the element on its own path when it cannot be routed", async () => {
    const { ctl, calls, events, lastState } = await harness({
      audio: { config: { contextRate: 96000 }, faults: { throwOnSource: true } },
    });
    await ctl.play(song, 0);
    expect(calls).toContainEqual({ play: true });
    expect(lastState().audioGraph).toBe("waiting");
    expect(ctl.setEq([{ freqHz: 60, gainDb: 4 }])).toBe(false);
    expect(events.some(e => e.name === "error" && /could not reach the player/.test(String(e.data.message)))).toBe(true);
  });

  it("resumes a suspended context before playing into it", async () => {
    const { ctl, webAudio } = await harness({ audio: { config: { contextRate: 96000 }, faults: { suspended: true } } });
    await ctl.play(song, 0);
    const ctx = webAudio.contexts[0]!;
    expect(ctx.state).toBe("running");
    expect(ctx.sources).toHaveLength(1);
  });

  it("leaves the element direct while the context cannot start", async () => {
    const { ctl, calls, webAudio, lastState } = await harness({
      audio: { config: { contextRate: 96000 }, faults: { suspended: true, resumeFails: true } },
    });
    await ctl.play(song, 0);
    expect(calls).toContainEqual({ play: true });
    expect(webAudio.contexts[0]!.sources).toHaveLength(0);
    expect(lastState()).toMatchObject({ audioGraph: "waiting", contextState: "suspended" });
  });
});
