/**
 * Regression tests for bugs the TLA+ model found in the coordinator.
 * Each test replays a counterexample trace against the real Coordinator
 * with a controllable FakeAdapter. Spec: apps/desktop/spec/tla/.
 *
 * Before the fixes, every test in this file fails.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterEvent, PlaybackLease, QueueItem } from "@cadence/protocol";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { Coordinator } from "../src/coordinator/coordinator.js";
import { SettingsStore } from "../src/coordinator/settings-store.js";
import { FakeAdapter, fakeItem } from "./fake-adapter.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
});

/** FakeAdapter with promises the test controls. */
class ControlledAdapter extends FakeAdapter {
  hangSetVolume = false;
  deferredPrepare: (() => void) | null = null;
  throwSyncPrepare: Error | null = null;
  deferredPrefetch: (() => void) | null = null;
  failPrefetch: Error | null = null;

  override prepare(): Promise<void> {
    this.calls.push("prepare");
    if (this.throwSyncPrepare !== null) throw this.throwSyncPrepare;
    if (this.deferredPrepare !== null) {
      const release = this.deferredPrepare;
      this.deferredPrepare = null;
      return new Promise<void>((res) => {
        this.deferredPrepare = null;
        (this as { __release?: (() => void) | undefined }).__release = () => res();
        void release;
      });
    }
    return Promise.resolve();
  }

  releasePrepare(): void {
    const r = (this as { __release?: (() => void) | undefined }).__release;
    (this as { __release?: (() => void) | undefined }).__release = undefined;
    r?.();
  }

  override prefetch(item: QueueItem): Promise<void> {
    this.calls.push(`prefetch:${item.queueId}`);
    if (this.failPrefetch !== null) return Promise.reject(this.failPrefetch);
    if (this.deferredPrefetch !== null) {
      const pending = this.deferredPrefetch;
      this.deferredPrefetch = null;
      return new Promise<void>((res) => {
        (this as { __pre?: (() => void) | undefined }).__pre = () => res();
        void pending;
      });
    }
    return Promise.resolve();
  }

  resolvePrefetch(): void {
    const r = (this as { __pre?: (() => void) | undefined }).__pre;
    (this as { __pre?: (() => void) | undefined }).__pre = undefined;
    r?.();
  }

  override setVolume(volume: number): Promise<void> {
    this.calls.push(`setVolume:${volume}`);
    this.volumes.push(volume);
    if (this.hangSetVolume) return new Promise<never>(() => {});
    return Promise.resolve();
  }
}

function rig(overrides?: (a: ControlledAdapter) => void) {
  const dir = mkdtempSync(join(tmpdir(), "cadence-verify-"));
  dirs.push(dir);
  const store = new SettingsStore(join(dir, "settings.json"));
  const registry = new AdapterRegistry();
  const local = new ControlledAdapter("local");
  overrides?.(local);
  registry.register(local);
  const yt = new ControlledAdapter("youtube-music");
  registry.register(yt);
  const coordinator = new Coordinator({ registry, store, persistDebounceMs: 0 });
  const done = () => coordinator.dispose();
  return { coordinator, local, yt, done };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("model finding: unguarded chain links drop the next command", () => {
  it("a rejection in the ended-advance link must not eat the next command", async () => {
    const { coordinator, local, done } = rig((a) => {
      // keep pendingPrefetch null so `ended` takes the immediate chain path
      a.failPrefetch = new Error("no prefetch");
    });
    await coordinator.handleCommand({
      kind: "setQueue",
      items: [fakeItem("a"), fakeItem("b")],
      startIndex: 0,
      autoplay: true,
    });
    await flush();
    // Arm the throw AFTER the autoplay committed the lease, and make
    // failStart's error emission throw through a crashing listener — the
    // throw escapes the chain link.
    local.throwSyncPrepare = new Error("prepare exploded synchronously");
    coordinator.onEvent((e) => {
      if (e.kind === "error") throw new Error("ui listener crash");
    });
    local.emitAdapterEvent({ kind: "ended", generationId: 1 });
    await flush();

    // The next user command must still run.
    await coordinator.handleCommand({ kind: "setVolume", volume: 0.5 });
    expect(coordinator.getSnapshot().volume).toBe(0.5);
    done();
  });

  it("a rejection in the restart link must not eat the next command", async () => {
    const { coordinator, done } = rig();
    const registry = (coordinator as unknown as { registry: AdapterRegistry }).registry;
    await coordinator.handleCommand({
      kind: "setQueue",
      items: [fakeItem("a")],
      startIndex: 0,
      autoplay: true,
    });
    // restoreAfterEngineRestart fails; the error listener then throws,
    // which escapes restoreAfterRestart's catch — a real-world crash path
    // the unguarded link could not survive.
    const adapter = registry.get("local") as ControlledAdapter;
    (adapter as unknown as Record<string, unknown>).restoreAfterEngineRestart = () =>
      Promise.reject(new Error("engine restore failed"));
    coordinator.onEvent((e) => {
      if (e.kind === "error") throw new Error("ui listener crash");
    });
    coordinator.notifyEngineRestarted("local");
    await flush();
    await coordinator.handleCommand({ kind: "setVolume", volume: 0.3 });
    expect(coordinator.getSnapshot().volume).toBe(0.3);
    done();
  });
});

describe("model finding: setVolume has no timeout", () => {
  it("a wedged adapter setVolume cannot freeze the command chain", async () => {
    vi.useFakeTimers();
    const { coordinator, local, done } = rig();
    await coordinator.handleCommand({
      kind: "setQueue",
      items: [fakeItem("a"), fakeItem("b")],
      startIndex: 0,
      autoplay: true,
    });
    await vi.advanceTimersByTimeAsync(50);
    local.hangSetVolume = true;

    let setDone = false;
    const p = coordinator
      .handleCommand({ kind: "setVolume", volume: 0.5 })
      .then(() => {
        setDone = true;
      });
    await vi.advanceTimersByTimeAsync(11_000);
    await p;
    // The wedged call must have timed out rather than frozen the chain.
    expect(setDone).toBe(true);

    // And the chain behind it still runs.
    let pauseDone = false;
    const p2 = coordinator.handleCommand({ kind: "pause" }).then(() => {
      pauseDone = true;
    });
    await vi.advanceTimersByTimeAsync(50);
    await p2;
    expect(pauseDone).toBe(true);
    expect(local.calls).toContain("pause:g1");
    done();
  });
});

describe("model finding: prefetch belief untracked across handoff", () => {
  it("a prefetch resolved after a handoff must not feed promoteTrack's fallback", async () => {
    const { coordinator, local, done } = rig();
    await coordinator.handleCommand({
      kind: "setQueue",
      items: [fakeItem("a"), fakeItem("b"), fakeItem("c")],
      startIndex: 0,
      autoplay: true,
    });
    await flush();
    const qa = coordinator.getQueue().items[0]!.queueId;
    const qb = coordinator.getQueue().items[1]!.queueId;

    // Suspend the prefetch the first start issued; let later prefetches
    // fail so pendingPrefetch must stay empty on the fixed code.
    let prefetchRelease!: () => void;
    const prefetchPromise = new Promise<void>((res) => {
      prefetchRelease = res;
    });
    let firstCall = true;
    local.prefetch = (item: QueueItem) => {
      local.calls.push(`prefetch:${item.queueId}`);
      if (firstCall) {
        firstCall = false;
        return prefetchPromise;
      }
      return Promise.reject(new Error("prefetch unavailable"));
    };

    // Re-issue a start so a prefetch goes in flight, then hand off to b.
    await coordinator.handleCommand({ kind: "play", queueId: qa });
    await coordinator.handleCommand({ kind: "play", queueId: qb });
    await flush();
    const liveGen = coordinator.getSnapshot().lease!.generationId;
    // The stale prefetch resolves AFTER the handoff committed a newer lease.
    prefetchRelease();
    await flush();

    // b ends; then the engine reports a promoted start for a queueId the
    // coordinator does not know. The stale pendingPrefetch must not turn the
    // foreign promotion into a known item.
    local.emitAdapterEvent({ kind: "ended", generationId: liveGen, queueId: qb });
    local.emitAdapterEvent({
      kind: "started",
      generationId: liveGen,
      queueId: "q-foreign",
      promoted: true,
    });

    // Honest handling: warn and keep the lease on the foreign queueId,
    // rather than silently re-pointing the lease at a stale prefetch.
    expect(coordinator.getSnapshot().lease?.queueId).toBe("q-foreign");
    done();
  });
});

describe("model finding: stale ended-advance stomps the user's track", () => {
  it("an advance queued before a user start must not run after it", async () => {
    const { coordinator, local, done } = rig();
    await coordinator.handleCommand({
      kind: "setQueue",
      items: [fakeItem("a"), fakeItem("b"), fakeItem("c")],
      startIndex: 0,
      autoplay: true,
    });
    await flush();
    const qb = coordinator.getQueue().items[1]!.queueId;

    // Defer b's prepare so we can interleave a's `ended` mid-handoff.
    let releasePrepare!: () => void;
    const origPrepare = local.prepare.bind(local);
    let armed = false;
    local.prepare = () => {
      local.calls.push("prepare");
      if (!armed) return origPrepare();
      armed = false; // defer only the first prepare
      return new Promise<void>((res) => {
        releasePrepare = res;
      });
    };
    armed = true;

    // User explicitly picks b. While b prepares, a's engine reports `ended`:
    // the advance link queues behind the user's start and targets c
    // (successor of the in-flight index) — a stomp if it runs.
    const userPlay = coordinator.handleCommand({ kind: "play", queueId: qb });
    await flush(); // let the chain reach the deferred prepare
    local.emitAdapterEvent({ kind: "ended", generationId: 1 });
    releasePrepare();
    await userPlay;
    await flush();
    await new Promise((r) => setTimeout(r, 20));

    // The user's choice must stand — the stale advance must not run.
    expect(local.playedItems.at(-1)?.queueId).toBe(qb);
    done();
  });
});

describe("model finding: late started resurrects a failed start", () => {
  it("a play failure releases the lease so a late started stays gated out", async () => {
    const { coordinator, local, done } = rig();
    await coordinator.handleCommand({
      kind: "setQueue",
      items: [fakeItem("a"), fakeItem("b")],
      startIndex: 0,
      autoplay: true,
    });
    await flush();
    const qb = coordinator.getQueue().items[1]!.queueId;
    local.failPlay = new Error("play blew up");
    await coordinator.handleCommand({ kind: "play", queueId: qb });
    expect(coordinator.getSnapshot().status).toBe("error");
    const failedGen = coordinator.getSnapshot().lease?.generationId ?? 2;

    // A `started` for the failed attempt's generation must not flip
    // status back to playing — the attempt is dead.
    local.emitAdapterEvent({ kind: "started", generationId: failedGen });
    await flush();
    expect(coordinator.getSnapshot().status).toBe("error");
    done();
  });
});

describe("model finding: promotion mid-handoff desyncs queue intent", () => {
  it("the committed item keeps currentIndex even if promoteTrack moved it", async () => {
    const { coordinator, local, done } = rig();
    await coordinator.handleCommand({
      kind: "setQueue",
      items: [fakeItem("a"), fakeItem("b"), fakeItem("c")],
      startIndex: 0,
      autoplay: true,
    });
    await flush();
    const qa = coordinator.getQueue().items[0]!.queueId;
    const qc = coordinator.getQueue().items[2]!.queueId;

    // Start item a again; while it prepares, the engine self-promotes c on
    // the live (old) generation.
    const origPrepare = local.prepare.bind(local);
    let armed = true;
    local.prepare = () => {
      local.calls.push("prepare");
      if (!armed) return origPrepare();
      armed = false;
      return new Promise<void>((res) => {
        queueMicrotask(() => res());
        // Interleave the promotion while startItem awaits prepare.
        local.emitAdapterEvent({
          kind: "started",
          generationId: 1,
          queueId: qc,
          promoted: true,
        });
      });
    };
    await coordinator.handleCommand({ kind: "play", queueId: qa });
    await flush();

    // The committed play (item a) owns intent — index must point at a.
    expect(coordinator.getQueue().currentIndex).toBe(0);
    expect(coordinator.getSnapshot().current?.queueId).toBe(qa);
    done();
  });

  it("a failed prepare restores the index the lease names, not a stale one", async () => {
    const { coordinator, local, done } = rig();
    await coordinator.handleCommand({
      kind: "setQueue",
      items: [fakeItem("a"), fakeItem("b")],
      startIndex: 0,
      autoplay: true,
    });
    await flush();
    const qb = coordinator.getQueue().items[1]!.queueId;

    // During b's prepare the engine self-promotes b on the live generation;
    // then the prepare fails. The lease names b — the index must stay b.
    local.prepare = () => {
      local.calls.push("prepare");
      local.emitAdapterEvent({
        kind: "started",
        generationId: 1,
        queueId: qb,
        promoted: true,
      });
      return Promise.reject(new Error("prepare refused"));
    };
    await coordinator.handleCommand({ kind: "play", queueId: qb });
    await flush();

    expect(coordinator.getQueue().currentIndex).toBe(1);
    done();
  });
});

describe("model finding: resurrected outgoing engine stays audible", () => {
  it("commit re-silences an outgoing engine that self-promoted mid-handoff", async () => {
    const { coordinator, local, yt, done } = rig();
    await coordinator.handleCommand({
      kind: "setQueue",
      items: [fakeItem("a", "local"), fakeItem("b", "local"), fakeItem("c", "youtube-music")],
      startIndex: 0,
      autoplay: true,
    });
    await flush();
    const qb = coordinator.getQueue().items[1]!.queueId;
    const qc = coordinator.getQueue().items[2]!.queueId;

    // Track physical output: play marks the engine sounding, stop clears.
    let localSounding = true;
    const origLocalPlay = local.play.bind(local);
    const origLocalStop = local.stop.bind(local);
    local.play = (item: QueueItem, lease: PlaybackLease, opts: { positionMs?: number }) => {
      localSounding = true;
      return origLocalPlay(item, lease, opts);
    };
    let resurrected = false;
    local.stop = (lease: PlaybackLease) => {
      const p = origLocalStop(lease);
      localSounding = false;
      if (!resurrected) {
        resurrected = true;
        // The just-stopped engine self-promotes on the OLD generation —
        // output resumes after the stop returned.
        local.emitAdapterEvent({
          kind: "started",
          generationId: 1,
          queueId: qb,
          promoted: true,
        });
        localSounding = true;
      }
      return p;
    };
    await coordinator.handleCommand({ kind: "play", queueId: qc });
    await flush();

    // The commit's awaited re-stop silenced the resurrected engine before
    // the incoming play — it cannot keep sounding alongside yt.
    const stops = local.calls.filter((c) => c.startsWith("stop:"));
    expect(stops.length).toBeGreaterThanOrEqual(2);
    expect(localSounding).toBe(false);
    done();
  });
});

describe("persisted state: corrupt settings must not restore", () => {
  it("rejects a queue whose currentIndex is out of bounds", async () => {
    const { parsePersistedPlayback } = await import(
      "../src/coordinator/persisted-state.js"
    );
    const corrupt = {
      version: 1,
      queue: {
        owner: "coordinator",
        items: [{ queueId: "q1", track: fakeItem("a").track }],
        currentIndex: 5,
        shuffle: false,
        repeat: "off",
      },
      positionMs: 0,
      volume: 1,
      muted: false,
      fidelityMode: false,
      volumeByRoute: {},
    };
    expect(parsePersistedPlayback(corrupt)).toBeNull();
  });

  it("rejects items whose track lacks required fields", async () => {
    const { parsePersistedPlayback } = await import(
      "../src/coordinator/persisted-state.js"
    );
    const corrupt = {
      version: 1,
      queue: {
        owner: "coordinator",
        items: [{ queueId: "q1", track: { nope: true } }],
        currentIndex: 0,
        shuffle: false,
        repeat: "off",
      },
    };
    expect(parsePersistedPlayback(corrupt)).toBeNull();
  });
});

describe("model finding: advance target follows the ended item", () => {
  it("a prepare failure does not let a stale advance skip the successor", async () => {
    // [a,b,c], a playing. User picks b; b's prepare is deferred. a's engine
    // reports ended → the advance link is queued. b's prepare then fails and
    // the lease rolls back to a — the advance must target a's successor (b),
    // not c (the provisional index's successor).
    const { coordinator, local, done } = rig();
    await coordinator.handleCommand({
      kind: "setQueue",
      items: [fakeItem("a"), fakeItem("b"), fakeItem("c")],
      startIndex: 0,
      autoplay: true,
    });
    await flush();
    const qb = coordinator.getQueue().items[1]!.queueId;

    const origPrepare = local.prepare.bind(local);
    let armed = true;
    local.prepare = () => {
      local.calls.push("prepare");
      if (!armed) return origPrepare();
      armed = false;
      return new Promise<void>((_res, rej) => {
        queueMicrotask(() => rej(new Error("prepare refused")));
        // While b's prepare is pending, a's engine reports ended.
        local.emitAdapterEvent({ kind: "ended", generationId: 1 });
      });
    };
    local.failPrefetch = new Error("no prefetch");
    await coordinator.handleCommand({ kind: "play", queueId: qb });
    await flush();
    await new Promise((r) => setTimeout(r, 30));

    // The ended track was a — its successor is b. The advance may retry b
    // (which will fail again) but must never start c.
    expect(local.playedItems.every((i) => i.queueId !== coordinator.getQueue().items[2]!.queueId)).toBe(
      true,
    );
    done();
  });
});

describe("model finding: hung restart restore wedges the chain", () => {
  it("restoreAfterEngineRestart is bounded like every adapter call", async () => {
    vi.useFakeTimers();
    const { coordinator, done } = rig();
    const registry = (coordinator as unknown as { registry: AdapterRegistry }).registry;
    await coordinator.handleCommand({
      kind: "setQueue",
      items: [fakeItem("a")],
      startIndex: 0,
      autoplay: true,
    });
    await vi.advanceTimersByTimeAsync(50);
    const adapter = registry.get("local") as ControlledAdapter;
    (adapter as unknown as Record<string, unknown>).restoreAfterEngineRestart = () =>
      new Promise(() => {});
    coordinator.notifyEngineRestarted("local");
    await vi.advanceTimersByTimeAsync(20_000);
    // The chain survived the wedged restore — the next command runs.
    let doneCmd = false;
    const p = coordinator.handleCommand({ kind: "setVolume", volume: 0.4 }).then(() => {
      doneCmd = true;
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await p;
    expect(doneCmd).toBe(true);
    expect(coordinator.getSnapshot().volume).toBe(0.4);
    done();
  });
});

describe("model finding: timed advance target is settled at run time", () => {
  it("a repeat change queued behind a wedged chain affects the armed advance", async () => {
    vi.useFakeTimers();
    const { coordinator, local, done } = rig();
    const microFlush = async () => {
      for (let i = 0; i < 30; i++) await Promise.resolve();
    };
    await coordinator.handleCommand({
      kind: "setQueue",
      items: [fakeItem("a"), fakeItem("b")],
      startIndex: 0,
      autoplay: true,
    });
    await microFlush();
    const qa = coordinator.getQueue().items[0]!.queueId;

    // Wedge the chain on a never-resolving setVolume, then queue a repeat
    // change and let the promotion window arm + fire behind it. When the
    // advance link finally runs, repeat=one must make it replay the ended
    // item — not the successor the timer saw when it fired.
    const wedged = new Promise<void>(() => {});
    let wedgedOnce = false;
    const origSetVolume = local.setVolume.bind(local);
    local.setVolume = (v: number) => {
      if (!wedgedOnce) {
        wedgedOnce = true;
        return wedged;
      }
      return origSetVolume(v);
    };
    void coordinator.handleCommand({ kind: "setVolume", volume: 0.5 });
    local.emitAdapterEvent({ kind: "ended", generationId: 1, queueId: qa });
    void coordinator.handleCommand({ kind: "setRepeat", repeat: "one" });
    await vi.advanceTimersByTimeAsync(700); // window fires; link queues
    await vi.advanceTimersByTimeAsync(10_500); // wedged setVolume times out
    await microFlush();

    const lastPlay = local.calls.filter((c) => c.startsWith("play:")).at(-1);
    expect(lastPlay).toBe(`play:${qa}:g2`);
    done();
  });
});

describe("model finding: no successor when the advance link runs", () => {
  it("removing the queued advance's target stops the session", async () => {
    vi.useFakeTimers();
    const { coordinator, local, done } = rig((a) => {
      a.failPrefetch = new Error("no prefetch"); // immediate chain path
    });
    const microFlush = async () => {
      for (let i = 0; i < 30; i++) await Promise.resolve();
    };
    await coordinator.handleCommand({
      kind: "setQueue",
      items: [fakeItem("a"), fakeItem("b")],
      startIndex: 0,
      autoplay: true,
    });
    await microFlush();
    const qa = coordinator.getQueue().items[0]!.queueId;
    const qb = coordinator.getQueue().items[1]!.queueId;

    // Wedge the chain, queue the remove BEFORE the ended's advance link,
    // then let the wedge time out. The link must find no successor and
    // stop — not keep reporting "playing" over a dead engine.
    const wedged = new Promise<void>(() => {});
    let wedgedOnce = false;
    const origSetVolume = local.setVolume.bind(local);
    local.setVolume = (v: number) => {
      if (!wedgedOnce) {
        wedgedOnce = true;
        return wedged;
      }
      return origSetVolume(v);
    };
    void coordinator.handleCommand({ kind: "setVolume", volume: 0.5 });
    void coordinator.handleCommand({ kind: "remove", queueIds: [qb] });
    local.emitAdapterEvent({ kind: "ended", generationId: 1, queueId: qa });
    await microFlush();
    await vi.advanceTimersByTimeAsync(11_000);
    await microFlush();

    const snap = coordinator.getSnapshot();
    expect(snap.status).toBe("stopped");
    expect(snap.lease).toBeNull();
    done();
  });
});
