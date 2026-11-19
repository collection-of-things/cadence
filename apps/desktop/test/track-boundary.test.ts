/**
 * Track-boundary rules, tested directly. Later lease checks hide most
 * mistakes in this logic from the wider suite (a stale advance fails its
 * lease check, so a missed cancel looks harmless), so these tests watch the
 * rules themselves: `trackEnded` once per key, the 600ms promotion window,
 * and everything that closes it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoordinatorEvent } from "@cadence/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { Coordinator } from "../src/coordinator/coordinator.js";
import { SettingsStore } from "../src/coordinator/settings-store.js";
import { FakeAdapter, fakeItem } from "./fake-adapter.js";

const WINDOW_MS = 600;
const dirs: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A playing queue of `ids` on a fake local engine, with the successor prefetched. */
async function playing(ids: string[], opts: { prefetch?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cadence-boundary-"));
  dirs.push(dir);
  const store = new SettingsStore(join(dir, "settings.json"));
  const registry = new AdapterRegistry();
  const local = new FakeAdapter("local");
  if (opts.prefetch === false) local.prefetch = () => Promise.reject(new Error("no prefetch"));
  registry.register(local);
  const coordinator = new Coordinator({ registry, store, persistDebounceMs: 0 });
  const events: CoordinatorEvent[] = [];
  coordinator.onEvent((e) => events.push(e));
  await coordinator.handleCommand({
    kind: "setQueue",
    items: ids.map((id) => fakeItem(id)),
    startIndex: 0,
    autoplay: true,
  });
  await vi.advanceTimersByTimeAsync(50);
  const qids = coordinator.getQueue().items.map((it) => it.queueId);
  const qid = (i: number): string => {
    const q = qids[i];
    if (q === undefined) throw new Error(`no queue item ${i}`);
    return q;
  };
  const ended = () => events.filter((e) => e.kind === "trackEnded");
  const played = () => local.playedItems.map((p) => p.queueId);
  return { coordinator, local, qid, ended, played };
}

/** Timers pending beyond the ones a settled player keeps. */
async function settledTimers() {
  await vi.advanceTimersByTimeAsync(0);
  return vi.getTimerCount();
}

describe("track boundary: ended dedupe", () => {
  it("acts once on a repeated ended for the same generation and item", async () => {
    const r = await playing(["a", "b"]);
    expect(r.local.calls).toContain(`prefetch:${r.qid(1)}`);
    r.local.emitAdapterEvent({ kind: "ended", generationId: 1, queueId: r.qid(0) });
    r.local.emitAdapterEvent({ kind: "ended", generationId: 1, queueId: r.qid(0) });
    const base = await settledTimers();
    expect(r.ended()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(r.played()).toEqual([r.qid(0), r.qid(1)]);
    // One window, not two.
    expect(base).toBe(vi.getTimerCount() + 1);
    r.coordinator.dispose();
  });

  it("counts each item that ends under one promoted generation", async () => {
    const r = await playing(["a", "b", "c"]);
    r.local.emitAdapterEvent({ kind: "ended", generationId: 1, queueId: r.qid(0) });
    r.local.emitAdapterEvent({ kind: "started", generationId: 1, queueId: r.qid(1), promoted: true });
    await vi.advanceTimersByTimeAsync(50);
    r.local.emitAdapterEvent({ kind: "ended", generationId: 1, queueId: r.qid(1) });
    await vi.advanceTimersByTimeAsync(0);
    expect(r.ended().map((e) => e.kind === "trackEnded" && e.queueId)).toEqual([
      r.qid(0),
      r.qid(1),
    ]);
    r.coordinator.dispose();
  });
});

describe("track boundary: promotion window", () => {
  it("drives the advance itself exactly when the window passes", async () => {
    const r = await playing(["a", "b"]);
    r.local.emitAdapterEvent({ kind: "ended", generationId: 1, queueId: r.qid(0) });
    await vi.advanceTimersByTimeAsync(WINDOW_MS - 1);
    expect(r.played()).toEqual([r.qid(0)]);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.played()).toEqual([r.qid(0), r.qid(1)]);
    r.coordinator.dispose();
  });

  it("advances at once when nothing was prefetched", async () => {
    const r = await playing(["a", "b"], { prefetch: false });
    r.local.emitAdapterEvent({ kind: "ended", generationId: 1, queueId: r.qid(0) });
    await vi.advanceTimersByTimeAsync(50);
    expect(r.played()).toEqual([r.qid(0), r.qid(1)]);
    r.coordinator.dispose();
  });

  it("stops without advancing when nothing follows", async () => {
    const r = await playing(["a"]);
    r.local.emitAdapterEvent({ kind: "ended", generationId: 1, queueId: r.qid(0) });
    await vi.advanceTimersByTimeAsync(WINDOW_MS * 2);
    expect(r.ended()).toHaveLength(1);
    expect(r.played()).toEqual([r.qid(0)]);
    expect(r.coordinator.getSnapshot().status).toBe("stopped");
    r.coordinator.dispose();
  });

  it("a second end inside the window keeps the first deadline", async () => {
    const r = await playing(["a", "b", "c"]);
    r.local.emitAdapterEvent({ kind: "ended", generationId: 1, queueId: r.qid(0) });
    await vi.advanceTimersByTimeAsync(400);
    r.local.emitAdapterEvent({ kind: "ended", generationId: 1, queueId: r.qid(1) });
    await vi.advanceTimersByTimeAsync(WINDOW_MS - 400);
    expect(r.played()).toEqual([r.qid(0), r.qid(1)]);
    r.coordinator.dispose();
  });
});

describe("track boundary: what closes the window", () => {
  const closers = {
    "the engine promotes its prefetch": async (r: Awaited<ReturnType<typeof playing>>) => {
      r.local.emitAdapterEvent({ kind: "started", generationId: 1, queueId: r.qid(1), promoted: true });
    },
    "a new start begins": async (r: Awaited<ReturnType<typeof playing>>) => {
      await r.coordinator.handleCommand({ kind: "next" });
    },
    "playback stops": async (r: Awaited<ReturnType<typeof playing>>) => {
      await r.coordinator.handleCommand({ kind: "stop" });
    },
    "the provider tears playback down": async (r: Awaited<ReturnType<typeof playing>>) => {
      r.local.emitAdapterEvent({ kind: "stopped", generationId: 1 });
    },
  };

  it.each(Object.keys(closers) as (keyof typeof closers)[])(
    "%s",
    async (name) => {
      const r = await playing(["a", "b"]);
      const before = await settledTimers();
      r.local.emitAdapterEvent({ kind: "ended", generationId: 1, queueId: r.qid(0) });
      expect(await settledTimers()).toBe(before + 1);
      await closers[name](r);
      await vi.advanceTimersByTimeAsync(50);
      const playsAfterClose = r.played().length;
      // The window's timer is gone, not merely harmless when it fires.
      expect(vi.getTimerCount()).toBeLessThanOrEqual(before);
      await vi.advanceTimersByTimeAsync(WINDOW_MS * 2);
      expect(r.played()).toHaveLength(playsAfterClose);
      r.coordinator.dispose();
    },
  );
});
