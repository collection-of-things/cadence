import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { MUSICKIT_OUTPUT_JS } from "../src/adapters/providers/inject/musickit-output.js";

interface Output {
  prepare(): Promise<void>;
  pause(): Promise<void>;
  wake(): Promise<void>;
  idle(): void;
}

function browser(options: { delayedSuspend?: boolean; failModule?: boolean } = {}) {
  const media = { paused: false, ended: false, isConnected: true };
  const contexts: Context[] = [];
  let fail = options.failModule ?? false;
  class Node {
    connect() {}
    disconnect() {}
    port = { postMessage() {} };
  }
  class Context {
    state = "running";
    baseLatency = 0;
    outputLatency = 0;
    sampleRate = 48_000;
    destination = new Node();
    connected = new Set<unknown>();
    finishSuspend: (() => void) | undefined;
    audioWorklet = { addModule: async () => {
      if (fail) { fail = false; throw new Error("module unavailable"); }
    } };
    constructor() { contexts.push(this); }
    createMediaElementSource(element: unknown) {
      if (this.connected.has(element)) throw new Error("media element already attached");
      this.connected.add(element);
      return new Node();
    }
    async resume() { this.state = "running"; }
    async suspend() {
      if (options.delayedSuspend) await new Promise<void>(resolve => { this.finishSuspend = resolve; });
      this.state = "suspended";
    }
    async close() { this.state = "closed"; }
  }
  const sandbox = {
    window: {
      AudioContext: Context,
      document: { querySelector: () => media, querySelectorAll: () => [media], addEventListener() {} },
    },
    AudioWorkletNode: Node,
    Blob, URL, setTimeout, clearTimeout,
    emit() {},
    output: undefined as Output | undefined,
  };
  runInNewContext(MUSICKIT_OUTPUT_JS + ";globalThis.output = createMusicKitOutput();", sandbox);
  const output = sandbox.output;
  if (!output) throw new Error("Output factory did not install");
  const current = () => {
    const ctx = contexts.at(-1);
    if (!ctx) throw new Error("No context");
    return ctx;
  };
  return { output, media, current };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("injected MusicKit output lifecycle", () => {
  it("shares concurrent setup without attaching a media element twice", async () => {
    const { output, current } = browser();
    await Promise.all([output.prepare(), output.prepare()]);
    await output.prepare();
    expect(current().state).toBe("running");
  });

  it("resumes after an in-flight suspension instead of losing the wake", async () => {
    const { output, current } = browser({ delayedSuspend: true });
    await output.prepare();
    const pausing = output.pause();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const finish = current().finishSuspend;
    if (!finish) throw new Error("Suspension did not start");
    const waking = output.wake();
    finish();
    await Promise.all([pausing, waking]);
    expect(current().state).toBe("running");
  });

  it("sleeps after the SDK ends playback without an explicit controller pause", async () => {
    const { output, media, current } = browser();
    await output.prepare();
    media.paused = true;
    media.ended = true;
    output.idle();
    await sleep(30);
    expect(current().state).toBe("suspended");
  });

  it("does not let an old idle timer suspend the new playing stream", async () => {
    const { output, media, current } = browser();
    await output.prepare();
    media.paused = true;
    output.idle();
    await output.wake();
    media.paused = false;
    await sleep(30);
    expect(current().state).toBe("running");
  });

  it("can retry after worklet initialization fails", async () => {
    const { output, current } = browser({ failModule: true });
    await expect(output.prepare()).rejects.toThrow("module unavailable");
    expect(current().state).toBe("closed");
    await output.prepare();
    expect(current().state).toBe("running");
  });
});
