import { describe, expect, it } from "vitest";
import {
  AudioRpcError,
  AudioServiceClient,
  AudioServiceDown,
} from "../src/audio/audio-client.js";
import { mockSpawnFactory, type MockAudioService } from "./mock-audio-service.js";

function makeClient() {
  const { spawn, services } = mockSpawnFactory();
  const client = new AudioServiceClient({
    binaryPath: "/fake/cadence-audio",
    spawn,
    requestTimeoutMs: 500,
    restart: { baseDelayMs: 5, maxDelayMs: 20, maxAttempts: 5 },
  });
  return { client, services };
}

function lastService(services: MockAudioService[]): MockAudioService {
  const s = services.at(-1);
  if (s === undefined) throw new Error("no service spawned");
  return s;
}

describe("AudioServiceClient", () => {
  it("starts, answers requests, and correlates responses", async () => {
    const { client, services } = makeClient();
    await client.start();
    expect(client.isUp()).toBe(true);
    const svc = lastService(services);
    svc.handlers.set("audio.setVolume", (p) => ({ applied: (p as { volume: number }).volume }));
    const res = (await client.setVolume(0.5)) as { applied: number };
    expect(res.applied).toBe(0.5);
    expect(svc.methods()).toEqual(["audio.ping", "audio.setVolume"]);
    await client.dispose();
  });

  it("rejects with AudioRpcError on protocol errors and times out dead requests", async () => {
    const { client, services } = makeClient();
    await client.start();
    const svc = lastService(services);
    svc.handlers.set("audio.load", () => new Error("decode failed"));
    await expect(
      client.load({ queueId: "q1", generationId: 1, source: { kind: "file", path: "/x" } }),
    ).rejects.toBeInstanceOf(AudioRpcError);
    // No handler registered -> no response -> timeout.
    svc.delays.set("audio.seek", 5_000);
    await expect(client.seek(1, 1000)).rejects.toThrow(/timed out/);
    await client.dispose();
  });

  it("fans out service events", async () => {
    const { client, services } = makeClient();
    const events: { method: string }[] = [];
    client.onEvent((e) => events.push(e));
    await client.start();
    lastService(services).pushEvent("event.position", {
      generationId: 1,
      positionMs: 100,
      durationMs: 2000,
      atMs: 5,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.method).toBe("event.position");
    await client.dispose();
  });

  it("rejects in-flight requests on crash and restarts with backoff", async () => {
    const { client, services } = makeClient();
    const states: string[] = [];
    client.onStateChange((s) => states.push(s));
    await client.start();
    const svc1 = lastService(services);
    svc1.delays.set("audio.play", 5_000);
    const pending = client.play(1);
    const rejected = expect(pending).rejects.toBeInstanceOf(AudioServiceDown);
    svc1.crash();
    await rejected;
    // Backoff: respawn happens on a timer (5ms base) — poll briefly.
    let restarted = false;
    const restartedP = new Promise<void>((res) => {
      client.onRestarted(() => {
        restarted = true;
        res();
      });
    });
    await restartedP;
    expect(restarted).toBe(true);
    expect(services.length).toBe(2);
    expect(states).toContain("down");
    expect(client.isUp()).toBe(true);
    await client.dispose();
  });

  it("does not restart after an intentional dispose", async () => {
    const { client, services } = makeClient();
    await client.start();
    await client.dispose();
    await new Promise((r) => setTimeout(r, 50));
    expect(services.length).toBe(1);
    expect(client.isUp()).toBe(false);
  });

  it("openStream always uses the audio.feed pcm-stream source", async () => {
    // The fifo fast path is absent until the service implements fifoPath —
    // an armed flag would silently deadlock. Even CADENCE_AUDIO_FIFO=1 must
    // produce a plain pcm-stream source with no fifoPath.
    process.env.CADENCE_AUDIO_FIFO = "1";
    try {
      const { client, services } = makeClient();
      await client.start();
      const svc = lastService(services);
      svc.handlers.set("audio.load", () => ({}));
      svc.handlers.set("audio.feed", () => ({}));
      const stream = await client.openStream({
        queueId: "q9",
        generationId: 3,
        sampleRateHz: 44_100,
        channels: 2,
        bitDepth: "float",
      });
      const load = svc.received.find((r) => r.method === "audio.load");
      expect(load).toBeDefined();
      const source = (load?.params as { source: { kind: string; fifoPath?: string } }).source;
      expect(source.kind).toBe("pcm-stream");
      expect(source.fifoPath).toBeUndefined();
      await stream.end();
      await client.dispose();
    } finally {
      delete process.env.CADENCE_AUDIO_FIFO;
    }
  });

  it("openStream defaults to the audio.feed path", async () => {
    const { client, services } = makeClient();
    await client.start();
    const svc = lastService(services);
    svc.handlers.set("audio.load", () => ({}));
    svc.handlers.set("audio.feed", () => ({}));
    const stream = await client.openStream({
      queueId: "q10",
      generationId: 4,
      sampleRateHz: 44_100,
      channels: 2,
      bitDepth: 16,
    });
    const load = svc.received.find((r) => r.method === "audio.load");
    const source = (load?.params as { source: { kind: string; fifoPath?: string } }).source;
    expect(source.kind).toBe("pcm-stream");
    expect(source.fifoPath).toBeUndefined();
    await stream.write(new Uint8Array(8));
    const feed = svc.received.find((r) => r.method === "audio.feed");
    expect(feed).toBeDefined();
    expect((feed?.params as { queueId: string }).queueId).toBe("q10");
    expect(typeof (feed?.params as { dataBase64?: string }).dataBase64).toBe("string");
    await stream.end();
    const finalFeed = svc.received.filter((r) => r.method === "audio.feed").at(-1);
    expect((finalFeed?.params as { final?: boolean }).final).toBe(true);
    await client.dispose();
  });
});
