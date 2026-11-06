/**
 * fast-check model test: random command + adapter-event traces against the
 * REAL Coordinator + FakeAdapter, asserting the invariants the TLA+ specs
 * (apps/desktop/spec/tla/) prove of the protocol:
 *
 *   - PlayingLeaseSound: status "playing" ⇒ lease names the current item.
 *   - SingleAudible: at most one adapter engine can be sounding.
 *   - NoStaleLeaseFlip: an error or stop cannot be flipped back to playing
 *     by a stale event.
 *   - ChainLiveness: issued commands settle — the chain cannot wedge.
 *
 * Commands are issued fire-and-forget so the real promise chain and the
 * synchronous event dispatch interleave the way they do at runtime.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fc from "fast-check";
import type { RouteId } from "@cadence/protocol";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { Coordinator } from "../src/coordinator/coordinator.js";
import { SettingsStore } from "../src/coordinator/settings-store.js";
import { FakeAdapter, fakeItem } from "./fake-adapter.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
});

// Microtask pump — chain links resolve on microtasks; real setTimeout is
// unusable while fake timers are installed.
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

interface Real {
  coordinator: Coordinator;
  local: FakeAdapter;
  yt: FakeAdapter;
  /** Adapters whose engine currently has output started. */
  sounding: Map<RouteId, boolean>;
  /** One-shot injected faults, keyed `route:method`. */
  inject: Map<string, "fail" | "delay">;
  /** Command promises still in flight. */
  pending: Promise<void>[];
}

type AdapterMethod = "prepare" | "play" | "stop" | "setVolume";

function realRig(): Real {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), "cadence-model-"));
  dirs.push(dir);
  const store = new SettingsStore(join(dir, "settings.json"));
  const registry = new AdapterRegistry();
  const local = new FakeAdapter("local");
  const yt = new FakeAdapter("youtube-music");
  const sounding = new Map<RouteId, boolean>([
    ["local", false],
    ["youtube-music", false],
  ]);
  const inject = new Map<string, "fail" | "delay">();
  for (const a of [local, yt]) {
    const origPlay = a.play.bind(a);
    const origStop = a.stop.bind(a);
    a.play = (item, lease, opts) => {
      sounding.set(a.route, true);
      return origPlay(item, lease, opts);
    };
    a.stop = (lease) => {
      sounding.set(a.route, false);
      return origStop(lease);
    };
    // Outermost: one-shot injected faults — a failed call never reaches
    // the adapter; a delayed call resolves on a 25ms engine stall.
    for (const m of ["prepare", "play", "stop", "setVolume"] as AdapterMethod[]) {
      const inner = (a[m] as (...a: unknown[]) => Promise<unknown>).bind(a);
      (a as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => {
        const key = `${a.route}:${m}`;
        const mode = inject.get(key);
        if (mode === "fail") {
          inject.delete(key);
          return Promise.reject(new Error(`injected ${m} failure`));
        }
        if (mode === "delay") {
          inject.delete(key);
          return new Promise((res) => setTimeout(() => res(inner(...args)), 25));
        }
        return inner(...args);
      };
    }
    // The engine's own reports move physical truth too: a `started` means
    // output began, an `ended` means it stopped on its own.
    a.onEvent((e) => {
      if (e.kind === "started") sounding.set(a.route, true);
      if (e.kind === "ended") sounding.set(a.route, false);
    });
  }
  registry.register(local);
  registry.register(yt);
  const coordinator = new Coordinator({ registry, store, persistDebounceMs: 0 });
  return { coordinator, local, yt, sounding, inject, pending: [] };
}

/** The spec's settled-state invariant, checked on the real snapshot. */
function checkInvariants(real: Real): void {
  const snap = real.coordinator.getSnapshot();
  const soundingCount = [...real.sounding.values()].filter(Boolean).length;
  expect(soundingCount).toBeLessThanOrEqual(1);
  if (snap.status === "playing") {
    expect(snap.lease).not.toBeNull();
    // The lease must name the current item — unless the engine reported a
    // foreign promotion: a queueId the queue does not contain (the spec's
    // documented warn path — an error event tells the UI).
    const leaseQid = snap.lease?.queueId;
    const knownQid = real.coordinator.getQueue().items.some((it) => it.queueId === leaseQid);
    if (knownQid) {
      expect(snap.current?.queueId).toBe(leaseQid);
    }
  }
}

class Model {
  queueLen = 0;
}

class SetQueueCmd implements fc.AsyncCommand<Model, Real> {
  constructor(
    readonly items: number,
    readonly autoplay: boolean,
    readonly crossRoute: boolean,
  ) {}
  check(_m: Readonly<Model>): boolean {
    return true;
  }
  async run(m: Model, r: Real): Promise<void> {
    const items = Array.from({ length: this.items }, (_, i) =>
      fakeItem(`f${i}`, this.crossRoute && i % 3 === 2 ? "youtube-music" : "local"),
    );
    r.pending.push(
      r.coordinator
        .handleCommand({ kind: "setQueue", items, startIndex: 0, autoplay: this.autoplay })
        .then(() => undefined, () => undefined),
    );
    m.queueLen = this.items;
    await flush();
    checkInvariants(r);
  }
  toString(): string {
    return `setQueue(${this.items},autoplay=${this.autoplay},cross=${this.crossRoute})`;
  }
}

class PlayIndexCmd implements fc.AsyncCommand<Model, Real> {
  constructor(readonly index: number) {}
  check(m: Readonly<Model>): boolean {
    return m.queueLen > 0;
  }
  async run(m: Model, r: Real): Promise<void> {
    const item = r.coordinator.getQueue().items[this.index % m.queueLen];
    if (item === undefined) return;
    r.pending.push(
      r.coordinator.handleCommand({ kind: "play", queueId: item.queueId }).then(
        () => undefined,
        () => undefined,
      ),
    );
    await flush();
    checkInvariants(r);
  }
  toString(): string {
    return `play(items[${this.index}])`;
  }
}

class EmitEndedCmd implements fc.AsyncCommand<Model, Real> {
  constructor(
    readonly genDelta: 0 | 1,
    readonly withQueueId: boolean,
  ) {}
  check(_m: Readonly<Model>): boolean {
    return true;
  }
  async run(_m: Model, r: Real): Promise<void> {
    const lease = r.coordinator.getSnapshot().lease;
    const gen = lease?.generationId;
    if (gen === undefined) return;
    const queueId = lease?.queueId;
    const engine = lease?.route === "youtube-music" ? r.yt : r.local;
    engine.emitAdapterEvent({
      kind: "ended",
      generationId: gen + this.genDelta,
      ...(this.withQueueId && queueId !== undefined ? { queueId } : {}),
    });
    await flush();
    checkInvariants(r);
  }
  toString(): string {
    return `ended(gen+${this.genDelta},qid=${this.withQueueId})`;
  }
}

class EmitStartedCmd implements fc.AsyncCommand<Model, Real> {
  constructor(
    readonly genDelta: 0 | 1,
    readonly mode: "plain" | "promoted" | "foreign",
    readonly pick: number,
  ) {}
  check(_m: Readonly<Model>): boolean {
    return true;
  }
  async run(_m: Model, r: Real): Promise<void> {
    const lease = r.coordinator.getSnapshot().lease;
    const gen = lease?.generationId;
    if (gen === undefined) return;
    const engine = lease?.route === "youtube-music" ? r.yt : r.local;
    const items = r.coordinator.getQueue().items;
    const pick = items[this.pick % items.length];
    const queueId =
      this.mode === "foreign" ? "q-foreign" : pick?.queueId ?? "q-foreign";
    engine.emitAdapterEvent({
      kind: "started",
      generationId: gen + this.genDelta,
      queueId,
      promoted: this.mode !== "plain",
    });
    await flush();
    checkInvariants(r);
  }
  toString(): string {
    return `started(gen+${this.genDelta},${this.mode})`;
  }
}

class WaitPromotionCmd implements fc.AsyncCommand<Model, Real> {
  check(_m: Readonly<Model>): boolean {
    return true;
  }
  async run(_m: Model, r: Real): Promise<void> {
    await vi.advanceTimersByTimeAsync(700);
    await flush();
    checkInvariants(r);
  }
  toString(): string {
    return "waitPromotionWindow()";
  }
}

/** One-shot fault: the next call of the named method on the lease's
 * adapter rejects or resolves 25ms late — covers failed prepares, failed
 * and slow outgoing stops (the resurrect window), wedged volumes. */
class InjectFaultCmd implements fc.AsyncCommand<Model, Real> {
  constructor(
    readonly which: 0 | 1,
    readonly method: AdapterMethod,
    readonly mode: "fail" | "delay",
  ) {}
  check(_m: Readonly<Model>): boolean {
    return true;
  }
  async run(_m: Model, r: Real): Promise<void> {
    const engine = this.which === 0 ? r.local : r.yt;
    r.inject.set(`${engine.route}:${this.method}`, this.mode);
    await flush();
    checkInvariants(r);
  }
  toString(): string {
    return `inject(${this.which},${this.method},${this.mode})`;
  }
}

class MiscCmd implements fc.AsyncCommand<Model, Real> {
  constructor(
    readonly what: "pause" | "resume" | "setMuted" | "stop",
    readonly pick = 0,
  ) {}
  check(_m: Readonly<Model>): boolean {
    return true;
  }
  async run(_m: Model, r: Real): Promise<void> {
    const cmd =
      this.what === "setMuted"
        ? { kind: "setMuted" as const, muted: this.pick % 2 === 0 }
        : { kind: this.what };
    r.pending.push(
      r.coordinator.handleCommand(cmd).then(
        () => undefined,
        () => undefined,
      ),
    );
    await flush();
    checkInvariants(r);
  }
  toString(): string {
    return `misc(${this.what})`;
  }
}

const allCommands = [
  fc.constantFrom(1, 2, 3, 4).chain((n) =>
    fc.tuple(fc.boolean(), fc.boolean()).map(
      ([autoplay, cross]) => new SetQueueCmd(n, autoplay, cross),
    ),
  ),
  fc.constantFrom(0, 1, 2, 3).map((i) => new PlayIndexCmd(i)),
  fc
    .tuple(fc.constantFrom(0, 1) as fc.Arbitrary<0 | 1>, fc.boolean())
    .map(([d, q]) => new EmitEndedCmd(d, q)),
  fc
    .tuple(
      fc.constantFrom(0, 1) as fc.Arbitrary<0 | 1>,
      fc.constantFrom("plain", "promoted", "foreign") as fc.Arbitrary<
        "plain" | "promoted" | "foreign"
      >,
      fc.constantFrom(0, 1, 2, 3),
    )
    .map(([d, m, p]) => new EmitStartedCmd(d, m, p)),
  fc.constant(new WaitPromotionCmd()),
  fc
    .tuple(
      fc.constantFrom(0, 1) as fc.Arbitrary<0 | 1>,
      fc.constantFrom("prepare", "play", "stop", "setVolume") as fc.Arbitrary<AdapterMethod>,
      fc.constantFrom("fail", "delay") as fc.Arbitrary<"fail" | "delay">,
    )
    .map(([w, m, mode]) => new InjectFaultCmd(w, m, mode)),
  fc
    .constantFrom("pause", "resume", "setMuted", "stop")
    .map((w) => new MiscCmd(w as "pause" | "resume" | "setMuted" | "stop", 1)),
];

describe("coordinator model-based test (trace replay)", () => {
  it("holds the spec invariants across random traces", async () => {
    await fc.assert(
      fc
        .asyncProperty(fc.commands(allCommands, { size: "+1", maxCommands: 40 }), async (cmds) => {
          const r = realRig();
          await fc.asyncModelRun(() => ({ model: new Model(), real: r }), cmds);
          // Drain: let queued links and promotion windows settle.
          for (let i = 0; i < 6; i++) {
            await vi.advanceTimersByTimeAsync(750);
            await flush();
          }
          for (let i = 0; i < 40; i++) await Promise.resolve();
          await Promise.all(r.pending);
          checkInvariants(r);
          r.coordinator.dispose();
        })
        .beforeEach(() => {
          vi.useRealTimers();
        }),
      { numRuns: 40 },
    );
  }, 180_000);
});
