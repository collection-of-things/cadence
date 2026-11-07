/**
 * Queue edits must cancel an installed engine prefetch: when the track the
 * engine would promote at the boundary leaves the queue, the coordinator
 * calls adapter.clearPrefetch, which must reach the service as an
 * audio.clearPrefetch RPC under the current generation.
 *
 * Exercises the real Coordinator -> LocalRouteAdapter -> AudioServiceClient
 * path against the in-memory JSON-RPC service.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { LocalRouteAdapter } from "../src/adapters/local-route-adapter.js";
import { AudioServiceClient } from "../src/audio/audio-client.js";
import { Coordinator } from "../src/coordinator/coordinator.js";
import { SettingsStore } from "../src/coordinator/settings-store.js";
import { fakeItem } from "./fake-adapter.js";
import { mockSpawnFactory } from "./mock-audio-service.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const flush = () => new Promise((r) => setTimeout(r, 30));

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "cadence-clearpf-"));
  dirs.push(dir);
  const store = new SettingsStore(join(dir, "settings.json"));
  const { spawn: rawSpawn, services } = mockSpawnFactory();
  const spawn = (_bin: string) => {
    const s = rawSpawn();
    for (const m of [
      "audio.load",
      "audio.prefetch",
      "audio.clearPrefetch",
      "audio.play",
      "audio.pause",
      "audio.stop",
      "audio.setVolume",
      "audio.setFidelityMode",
      "audio.setReplayGain",
      "audio.seek",
    ]) {
      s.handlers.set(m, () => ({ ok: true }));
    }
    return s;
  };
  const client = new AudioServiceClient({
    binaryPath: "/fake/cadence-audio",
    spawn,
    requestTimeoutMs: 2_000,
    restart: { baseDelayMs: 5, maxDelayMs: 20, maxAttempts: 0 },
  });
  const local = new LocalRouteAdapter(client);
  const registry = new AdapterRegistry();
  registry.register(local);
  const coordinator = new Coordinator({ registry, store, persistDebounceMs: 0 });
  return { coordinator, client, services };
}

describe("clearPrefetch on queue edits", () => {
  it("issues audio.clearPrefetch when the prefetched successor leaves the queue", async () => {
    const { coordinator, client, services } = rig();
    await coordinator.handleCommand({
      kind: "setQueue",
      items: [fakeItem("a"), fakeItem("b")],
      startIndex: 0,
      autoplay: true,
    });
    await flush();

    const svc = services[0];
    expect(svc).toBeDefined();
    const methods = svc!.methods();
    expect(methods).toContain("audio.load");
    expect(methods).toContain("audio.prefetch");

    // Removing the successor leaves the engine's installed prefetch stale —
    // it must be cancelled under the load's generation (1).
    const successorId = coordinator.getQueue().items[1]!.queueId;
    await coordinator.handleCommand({ kind: "remove", queueIds: [successorId] });
    await flush();

    const clears = svc!.received.filter((r) => r.method === "audio.clearPrefetch");
    expect(clears.length).toBeGreaterThan(0);
    expect((clears.at(-1)!.params as { generationId: number }).generationId).toBe(1);
    coordinator.dispose();
    await client.dispose();
  });

  it("re-prefetches (no clear) when a non-successor leaves the queue", async () => {
    const { coordinator, client, services } = rig();
    await coordinator.handleCommand({
      kind: "setQueue",
      items: [fakeItem("a"), fakeItem("b"), fakeItem("c")],
      startIndex: 0,
      autoplay: true,
    });
    await flush();
    const svc = services[0]!;
    const prefetchCallsBefore = svc.received.filter((r) => r.method === "audio.prefetch").length;
    expect(prefetchCallsBefore).toBeGreaterThan(0);

    // Removing a track that is NOT next-in-line keeps the same successor —
    // refreshPrefetch re-issues prefetch, never clearPrefetch.
    const tailId = coordinator.getQueue().items[2]!.queueId;
    await coordinator.handleCommand({ kind: "remove", queueIds: [tailId] });
    await flush();

    expect(svc.received.filter((r) => r.method === "audio.clearPrefetch")).toHaveLength(0);
    expect(svc.received.filter((r) => r.method === "audio.prefetch").length).toBeGreaterThan(
      prefetchCallsBefore,
    );
    coordinator.dispose();
    await client.dispose();
  });
});
