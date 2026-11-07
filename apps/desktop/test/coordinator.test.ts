import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CoordinatorEvent, QueueItem } from "@cadence/protocol";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { Coordinator } from "../src/coordinator/coordinator.js";
import { SettingsStore } from "../src/coordinator/settings-store.js";
import { FakeAdapter, fakeItem } from "./fake-adapter.js";

interface Rig {
  coordinator: Coordinator;
  registry: AdapterRegistry;
  local: FakeAdapter;
  provider: FakeAdapter;
  events: CoordinatorEvent[];
  dir: string;
  storePath: string;
}

function makeRig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "cadence-coord-"));
  const storePath = join(dir, "settings.json");
  const store = new SettingsStore(storePath);
  const registry = new AdapterRegistry();
  const local = new FakeAdapter("local");
  const provider = new FakeAdapter("youtube-music");
  registry.register(local);
  registry.register(provider);
  const coordinator = new Coordinator({ registry, store, persistDebounceMs: 0 });
  const events: CoordinatorEvent[] = [];
  coordinator.onEvent((e) => events.push(e));
  return { coordinator, registry, local, provider, events, dir, storePath };
}

let rigs: Rig[] = [];
afterEach(() => {
  for (const r of rigs) {
    r.coordinator.dispose();
    rmSync(r.dir, { recursive: true, force: true });
  }
  rigs = [];
});

function rig(): Rig {
  const r = makeRig();
  rigs.push(r);
  return r;
}

function snapshots(r: Rig) {
  return r.events.filter((e): e is Extract<CoordinatorEvent, { kind: "snapshot" }> => e.kind === "snapshot");
}

function lastSnapshot(r: Rig) {
  return snapshots(r).at(-1)?.snapshot;
}

function queueEvents(r: Rig) {
  return r.events.filter((e): e is Extract<CoordinatorEvent, { kind: "queue" }> => e.kind === "queue");
}

describe("coordinator: queue + leases", () => {
  it("setQueue re-stamps unique queueIds and autoplays with startIndex", async () => {
    const r = rig();
    const items = [fakeItem("a"), fakeItem("a")]; // same track twice
    await r.coordinator.handleCommand({ kind: "setQueue", items, startIndex: 0 });
    const q = r.coordinator.getQueue();
    expect(q.items).toHaveLength(2);
    expect(new Set(q.items.map((i) => i.queueId)).size).toBe(2);
    expect(q.items[0]?.queueId).not.toBe("in-a");
    expect(r.local.playedItems).toHaveLength(1);
    expect(r.coordinator.getSnapshot().status).toBe("playing");
    expect(r.coordinator.getSnapshot().lease?.generationId).toBe(1);
    expect(r.coordinator.getSnapshot().lease?.route).toBe("local");
  });

  it("setQueue without startIndex does not autoplay", async () => {
    const r = rig();
    await r.coordinator.handleCommand({ kind: "setQueue", items: [fakeItem("a")] });
    expect(r.local.playedItems).toHaveLength(0);
    expect(r.coordinator.getSnapshot().status).toBe("stopped");
  });

  it("insertNext/append/remove/move maintain the queue", async () => {
    const r = rig();
    await r.coordinator.handleCommand({ kind: "setQueue", items: [fakeItem("a"), fakeItem("b")] });
    await r.coordinator.handleCommand({ kind: "insertNext", items: [fakeItem("x")] });
    await r.coordinator.handleCommand({ kind: "append", items: [fakeItem("z")] });
    let titles = r.coordinator.getQueue().items.map((i) => i.track.title);
    expect(titles).toEqual(["Track a", "Track x", "Track b", "Track z"]);
    await r.coordinator.handleCommand({ kind: "move", fromIndex: 3, toIndex: 1 });
    titles = r.coordinator.getQueue().items.map((i) => i.track.title);
    expect(titles).toEqual(["Track a", "Track z", "Track x", "Track b"]);
    const toRemove = r.coordinator.getQueue().items[1]?.queueId;
    expect(toRemove).toBeDefined();
    await r.coordinator.handleCommand({ kind: "remove", queueIds: [toRemove ?? ""] });
    titles = r.coordinator.getQueue().items.map((i) => i.track.title);
    expect(titles).toEqual(["Track a", "Track x", "Track b"]);
    expect(queueEvents(r).length).toBeGreaterThan(0);
  });
});

describe("coordinator: handoff", () => {
  it("runs prepare-incoming -> stop-outgoing -> start-incoming across routes", async () => {
    const r = rig();
    const order: string[] = [];
    for (const [name, a] of [
      ["local", r.local],
      ["provider", r.provider],
    ] as const) {
      for (const m of ["prepare", "play", "stop"] as const) {
        const orig = a[m].bind(a);
        (a as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => {
          order.push(`${name}.${m}`);
          return (orig as (...a: unknown[]) => unknown)(...args);
        };
      }
    }
    const items: QueueItem[] = [fakeItem("a", "local"), fakeItem("b", "youtube-music")];
    await r.coordinator.handleCommand({ kind: "setQueue", items, startIndex: 0 });
    order.length = 0;
    const ytId = r.coordinator.getQueue().items[1]?.queueId ?? "";
    await r.coordinator.handleCommand({ kind: "play", queueId: ytId });
    expect(order).toEqual(["provider.prepare", "local.stop", "provider.play"]);
    expect(r.coordinator.getSnapshot().lease?.route).toBe("youtube-music");
    expect(r.coordinator.getQueue().owner).toBe("provider");
  });

  it("preserves the queue when the incoming adapter fails", async () => {
    const r = rig();
    const items = [fakeItem("a", "local"), fakeItem("b", "youtube-music")];
    await r.coordinator.handleCommand({ kind: "setQueue", items, startIndex: 0 });
    r.provider.failPlay = new Error("player rejected");
    const ytId = r.coordinator.getQueue().items[1]?.queueId ?? "";
    await r.coordinator.handleCommand({ kind: "play", queueId: ytId });
    const snap = r.coordinator.getSnapshot();
    expect(snap.status).toBe("error");
    expect(snap.lastError?.route).toBe("youtube-music");
    // Queue intact — the failed item is still there for a switchRoute retry.
    expect(r.coordinator.getQueue().items.map((i) => i.track.title)).toEqual([
      "Track a",
      "Track b",
    ]);
    const errs = r.events.filter((e) => e.kind === "error");
    expect(errs.at(-1)).toMatchObject({ kind: "error", route: "youtube-music", retriable: true });
  });

  it("drops stale-generation events from a dying route", async () => {
    const r = rig();
    const items = [fakeItem("a", "local"), fakeItem("b", "local")];
    await r.coordinator.handleCommand({ kind: "setQueue", items, startIndex: 0 });
    // gen 1 is live; switch to item 2 -> gen 2.
    const secondId = r.coordinator.getQueue().items[1]?.queueId ?? "";
    await r.coordinator.handleCommand({ kind: "play", queueId: secondId });
    const positionsBefore = r.events.filter((e) => e.kind === "position").length;
    // The old generation reports a late position + ended — both must be dropped.
    r.local.emitAdapterEvent({ kind: "position", positionMs: 99_000, atMs: 1, generationId: 1 });
    r.local.emitAdapterEvent({ kind: "ended", generationId: 1 });
    expect(r.events.filter((e) => e.kind === "position").length).toBe(positionsBefore);
    expect(r.events.filter((e) => e.kind === "trackEnded").length).toBe(0);
    expect(r.coordinator.getSnapshot().positionMs).not.toBe(99_000);
    // The current generation still gets through.
    r.local.emitAdapterEvent({ kind: "position", positionMs: 5_000, atMs: 2, generationId: 2 });
    expect(r.coordinator.getSnapshot().positionMs).toBe(5_000);
  });

  it("advances on trackEnded and honors repeat modes", async () => {
    const r = rig();
    const items = [fakeItem("a", "local"), fakeItem("b", "local")];
    await r.coordinator.handleCommand({ kind: "setQueue", items, startIndex: 0 });
    // ended on the live generation -> next item starts (after the
    // promotion window: the engine may self-start a prefetched successor)
    r.local.emitAdapterEvent({ kind: "ended", generationId: 1 });
    await new Promise((res) => setTimeout(res, 700));
    expect(r.local.playedItems.at(-1)?.queueId).toBe(r.coordinator.getQueue().items[1]?.queueId);
    // end of queue with repeat off -> stopped
    r.local.emitAdapterEvent({ kind: "ended", generationId: 2 });
    await new Promise((res) => setTimeout(res, 50));
    expect(r.coordinator.getSnapshot().status).toBe("stopped");
    // repeat all wraps
    await r.coordinator.handleCommand({ kind: "setRepeat", repeat: "all" });
    const firstId = r.coordinator.getQueue().items[0]?.queueId ?? "";
    await r.coordinator.handleCommand({ kind: "play", queueId: firstId });
    r.local.emitAdapterEvent({ kind: "ended", generationId: 3 });
    await new Promise((res) => setTimeout(res, 700));
    expect(r.local.playedItems.at(-1)?.queueId).toBe(r.coordinator.getQueue().items[1]?.queueId);
  });
});

describe("coordinator: volume memory + mute", () => {
  it("remembers volume per route and applies it on switch", async () => {
    const r = rig();
    const items = [fakeItem("a", "local"), fakeItem("b", "youtube-music")];
    await r.coordinator.handleCommand({ kind: "setQueue", items, startIndex: 0 });
    await r.coordinator.handleCommand({ kind: "setVolume", volume: 0.4 });
    const ytId = r.coordinator.getQueue().items[1]?.queueId ?? "";
    await r.coordinator.handleCommand({ kind: "play", queueId: ytId });
    // New route starts at the carried-over default volume (0.4 -> 1? default is
    // the last global volume; route-specific memory overrides it only when set
    // on that route).
    expect(r.provider.volumes.at(-1)).toBe(0.4);
    await r.coordinator.handleCommand({ kind: "setVolume", volume: 0.8 });
    const localId = r.coordinator.getQueue().items[0]?.queueId ?? "";
    await r.coordinator.handleCommand({ kind: "switchRoute", queueId: localId, route: "local" });
    // Back on local, the remembered 0.4 comes back rather than leaking 0.8.
    expect(r.local.volumes.at(-1)).toBe(0.4);
    expect(r.coordinator.getSnapshot().volume).toBe(0.4);
  });

  it("mutes by applying volume 0 to the engine, keeping the stored level", async () => {
    const r = rig();
    await r.coordinator.handleCommand({ kind: "setQueue", items: [fakeItem("a")], startIndex: 0 });
    await r.coordinator.handleCommand({ kind: "setMuted", muted: true });
    expect(r.local.volumes.at(-1)).toBe(0);
    expect(r.coordinator.getSnapshot().muted).toBe(true);
    expect(r.coordinator.getSnapshot().volume).toBe(1);
    await r.coordinator.handleCommand({ kind: "setMuted", muted: false });
    expect(r.local.volumes.at(-1)).toBe(1);
  });
});

describe("coordinator: persistence", () => {
  it("restores queue + position paused, without autoplay", async () => {
    const r = rig();
    await r.coordinator.handleCommand({ kind: "setQueue", items: [fakeItem("a"), fakeItem("b")] });
    await r.coordinator.handleCommand({ kind: "seek", positionMs: 42_000 });
    r.coordinator.dispose();

    // New coordinator over the same settings file.
    const registry = new AdapterRegistry();
    const local2 = new FakeAdapter("local");
    registry.register(local2);
    registry.register(new FakeAdapter("youtube-music"));
    const store = new SettingsStore(r.storePath);
    const c2 = new Coordinator({ registry, store, persistDebounceMs: 0 });
    const snap = c2.getSnapshot();
    expect(snap.status).toBe("paused");
    expect(snap.positionMs).toBe(42_000);
    expect(snap.lease).toBeNull();
    expect(c2.getQueue().items).toHaveLength(2);
    // Nothing was loaded into an engine — no autoplay.
    expect(local2.playedItems).toHaveLength(0);
    // Resume loads the current item at the remembered position.
    await c2.handleCommand({ kind: "resume" });
    expect(local2.playedItems).toHaveLength(1);
    expect(local2.playedItems[0]?.positionMs).toBe(42_000);
    c2.dispose();
  });

  it("play after a restored session continues the current item at its position", async () => {
    const r = rig();
    await r.coordinator.handleCommand({ kind: "setQueue", items: [fakeItem("a"), fakeItem("b")] });
    // Pause mid-way through the SECOND item so a "restart queue[0] at 0"
    // regression is visible.
    const secondId = r.coordinator.getQueue().items[1]?.queueId ?? "";
    await r.coordinator.handleCommand({ kind: "play", queueId: secondId });
    await r.coordinator.handleCommand({ kind: "seek", positionMs: 42_000 });
    r.coordinator.dispose();

    const registry = new AdapterRegistry();
    const local2 = new FakeAdapter("local");
    registry.register(local2);
    registry.register(new FakeAdapter("youtube-music"));
    const c2 = new Coordinator({ registry, store: new SettingsStore(r.storePath), persistDebounceMs: 0 });
    // The bare Play (no queueId) — what OS media keys send — must continue
    // the restored item, not restart queue[0] at 0.
    await c2.handleCommand({ kind: "play" });
    expect(local2.playedItems).toHaveLength(1);
    expect(local2.playedItems[0]?.queueId).toBe(c2.getQueue().items[1]?.queueId);
    expect(local2.playedItems[0]?.positionMs).toBe(42_000);
    expect(c2.getSnapshot().status).toBe("playing");
    c2.dispose();
  });
});

describe("coordinator: transport", () => {
  it("play after pause resumes the adapter — the item is not reloaded", async () => {
    const r = rig();
    await r.coordinator.handleCommand({
      kind: "setQueue",
      items: [fakeItem("a"), fakeItem("b")],
      startIndex: 1,
    });
    await r.coordinator.handleCommand({ kind: "seek", positionMs: 42_000 });
    await r.coordinator.handleCommand({ kind: "pause" });
    expect(r.coordinator.getSnapshot().status).toBe("paused");
    expect(r.local.playedItems).toHaveLength(1);

    // `play` is the spelling OS media keys and IPC clients dispatch for a
    // paused session (media-keys.ts); the coordinator must map it to a
    // resume, not a reload.
    await r.coordinator.handleCommand({ kind: "play" });
    const snap = r.coordinator.getSnapshot();
    expect(snap.status).toBe("playing");
    // Resume continues the loaded item: a resume on the same lease, not a
    // second play that would restart it (or queue[0]) at position 0.
    expect(r.local.calls).toContain(`resume:g${snap.lease?.generationId}`);
    expect(r.local.playedItems).toHaveLength(1);
    expect(snap.current?.queueId).toBe(r.coordinator.getQueue().items[1]?.queueId);
    expect(snap.positionMs).toBe(42_000);
  });
});

describe("coordinator: engine restart", () => {
  it("restores queue intent paused after a service restart", async () => {
    const r = rig();
    const { isRestartRestorable } = await import("../src/adapters/types.js");
    const restorable = new FakeAdapter("local");
    (restorable as unknown as Record<string, unknown>).restoreAfterEngineRestart = async () => {
      restorable.calls.push("restore");
    };
    const registry = new AdapterRegistry();
    registry.register(restorable);
    const coordinator = new Coordinator({ registry, store: new SettingsStore(join(r.dir, "s2.json")), persistDebounceMs: 0 });
    rigs.push({ ...r, coordinator });
    await coordinator.handleCommand({ kind: "setQueue", items: [fakeItem("a")], startIndex: 0 });
    await coordinator.handleCommand({ kind: "seek", positionMs: 12_000 });
    coordinator.notifyEngineRestarted("local");
    await new Promise((res) => setImmediate(res));
    expect(restorable.calls).toContain("restore");
    expect(coordinator.getSnapshot().status).toBe("paused");
    expect(coordinator.getQueue().items).toHaveLength(1);
    expect(isRestartRestorable(restorable)).toBe(true);
  });
});
