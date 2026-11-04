/**
 * Engine self-promotion at a gapless boundary: when the audio engine has a
 * prefetched successor and promotes it itself, the coordinator must advance
 * the queue WITHOUT issuing adapter.play again. Regression test for the
 * review finding that every seamless boundary was followed by a redundant
 * audio.load restarting the just-promoted track.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { Coordinator } from "../src/coordinator/coordinator.js";
import { SettingsStore } from "../src/coordinator/settings-store.js";
import { FakeAdapter, fakeItem } from "./fake-adapter.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "cadence-gapless-"));
  dirs.push(dir);
  const store = new SettingsStore(join(dir, "settings.json"));
  const registry = new AdapterRegistry();
  const local = new FakeAdapter("local");
  registry.register(local);
  const coordinator = new Coordinator({ registry, store, persistDebounceMs: 0 });
  return { coordinator, local };
}

const flush = () => new Promise((r) => setTimeout(r, 30));

describe("gapless promotion", () => {
  it("advances the queue without re-playing the promoted track", async () => {
    const { coordinator, local } = rig();
    await coordinator.handleCommand({
      kind: "setQueue",
      items: [fakeItem("a"), fakeItem("b")],
      startIndex: 0,
      autoplay: true,
    });
    await flush();
    const gen = 1;
    const q1 = coordinator.getQueue().items[0]!.queueId;
    const q2 = coordinator.getQueue().items[1]!.queueId;
    expect(local.calls).toContain(`play:${q1}:g1`);
    expect(local.calls).toContain(`prefetch:${q2}`);

    // Engine: seamless boundary — a ended, then b started by the engine.
    local.emitAdapterEvent({ kind: "ended", generationId: gen, gapless: true });
    local.emitAdapterEvent({ kind: "started", generationId: gen, queueId: q2, promoted: true });
    await flush();

    // The flagship invariant: exactly ONE play call total — the promoted
    // track is already sounding; a second load would restart it.
    expect(local.playedItems.length).toBe(1);
    expect(local.playedItems[0]!.queueId).toBe(q1);
    const q = coordinator.getQueue();
    expect(q.currentIndex).toBe(1);
    expect(coordinator.getSnapshot().current?.queueId).toBe(q2);
    // And the following successor is prefetched again for the next boundary.
    coordinator.dispose();
  });

  it("drives the advance itself when no promotion arrives", async () => {
    const { coordinator, local } = rig();
    await coordinator.handleCommand({
      kind: "setQueue",
      items: [fakeItem("a"), fakeItem("b")],
      startIndex: 0,
      autoplay: true,
    });
    await flush();
    const q2 = coordinator.getQueue().items[1]!.queueId;
    local.emitAdapterEvent({ kind: "ended", generationId: 1, gapless: false });
    // No prefetch promotion reported; wait out the promotion window.
    await new Promise((r) => setTimeout(r, 700));
    expect(local.playedItems.length).toBe(2);
    expect(local.playedItems[1]!.queueId).toBe(q2);
    coordinator.dispose();
  });

  it("promotes after a format-mismatch reopen (started, gapless flag false)", async () => {
    const { coordinator, local } = rig();
    await coordinator.handleCommand({
      kind: "setQueue",
      items: [fakeItem("a"), fakeItem("b")],
      startIndex: 0,
      autoplay: true,
    });
    await flush();
    const q2 = coordinator.getQueue().items[1]!.queueId;
    local.emitAdapterEvent({ kind: "ended", generationId: 1, gapless: false });
    local.emitAdapterEvent({ kind: "started", generationId: 1, queueId: q2, promoted: true });
    await flush();
    expect(local.playedItems.length).toBe(1);
    expect(coordinator.getQueue().currentIndex).toBe(1);
    coordinator.dispose();
  });
});
