/**
 * Apple provider route x real Coordinator integration. Only the remote page
 * boundary is simulated (ProviderSession); the adapter, coordinator, queue
 * persistence and — for the restart test — the AudioServiceClient supervisor
 * are all real. Covers the cross-boundary defects found by the integration
 * review plus the quit/restart and sign-in edges around them.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoordinatorEvent, QueueItem } from "@cadence/protocol";
import { AppleMusicKitAdapter } from "../src/adapters/providers/apple-musickit.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { Coordinator } from "../src/coordinator/coordinator.js";
import { SettingsStore } from "../src/coordinator/settings-store.js";
import { AudioServiceClient } from "../src/audio/audio-client.js";
import { FakeAdapter, fakeItem } from "./fake-adapter.js";
import { mockSpawnFactory } from "./mock-audio-service.js";

vi.mock("electron", () => ({ BrowserWindow: class {}, session: {}, webContents: {} }));

/** Only the remote page boundary is simulated; adapter and coordinator are real. */
class PageSession {
  evals: string[] = [];
  muted = false;
  hidden = false;
  hasOpenPopups = false;
  playGate: Promise<boolean> | null = null;
  /** Gate for the sign-in flow's authorize() eval — pending until released. */
  authorizeGate: Promise<boolean> | null = null;
  private popupCloseHandlers: Array<() => void> = [];
  private popupOpenHandlers: Array<() => void> = [];
  async prepare(): Promise<void> {}
  async eval(expression: string): Promise<unknown> {
    this.evals.push(expression);
    if (expression.startsWith("window.__cadenceCtl.play(")) return this.playGate ?? true;
    if (expression.includes("authorize()")) return this.authorizeGate ?? true;
    return true;
  }
  setAudioMuted(value: boolean): void { this.muted = value; }
  reset(): void {}
  async clearData(): Promise<void> {}
  async dispose(): Promise<void> {}
  async hasSessionCookies(): Promise<boolean> { return false; }
  hide(): void { this.hidden = true; }
  reveal(): void { this.hidden = false; }
  focusPopup(): boolean { return this.hasOpenPopups; }
  onPopupClosed(cb: () => void): () => void {
    this.popupCloseHandlers.push(cb);
    return () => {
      this.popupCloseHandlers = this.popupCloseHandlers.filter((h) => h !== cb);
    };
  }
  onPopupOpened(cb: () => void): () => void {
    this.popupOpenHandlers.push(cb);
    return () => {
      this.popupOpenHandlers = this.popupOpenHandlers.filter((h) => h !== cb);
    };
  }
}

function appleItem(id: string): QueueItem {
  const item = fakeItem(id, "apple-musickit");
  return { ...item, track: { ...item.track, source: { kind: "provider", providerItemId: id } } };
}

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "cadence-apple-coord-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SettingsStore(join(dir, "settings.json"));
  const registry = new AdapterRegistry();
  const apple = new AppleMusicKitAdapter();
  const page = new PageSession();
  // Existing adapter tests use the same session injection seam.
  (apple as unknown as { session: PageSession }).session = page;
  (apple as unknown as { installed: boolean }).installed = true;
  const local = new FakeAdapter("local");
  registry.register(apple);
  registry.register(local);
  let now = 100_000;
  const coordinator = new Coordinator({ registry, store, persistDebounceMs: 0, now: () => now });
  const events: CoordinatorEvent[] = [];
  coordinator.onEvent(event => events.push(event));
  cleanups.push(() => coordinator.dispose());
  const emitPage = (name: string, data: unknown) => {
    // Exercise the same callback ProviderSession invokes from its bridge.
    const boundary = apple as unknown as { onPageEvent(name: string, data: unknown): void };
    boundary.onPageEvent(name, data);
  };
  const drain = async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve();
    await coordinator.handleCommand({ kind: "setVolume", volume: 0.5 });
  };
  return { coordinator, registry, store, apple, local, page, emitPage, events, drain, tick: (ms: number) => { now += ms; } };
}

describe("apple route x coordinator", () => {
  it("preserves an unplayed Apple Play-next queue across quit/restart", async () => {
    const r = rig();
    await r.coordinator.handleCommand({ kind: "insertNext", items: [appleItem("a"), appleItem("b")] });
    expect(r.coordinator.getQueue().items).toHaveLength(2);
    r.coordinator.dispose();
    const restored = new Coordinator({ registry: r.registry, store: r.store });
    cleanups.push(() => restored.dispose());
    expect(restored.getQueue().items).toHaveLength(2);
    expect(r.page.evals).toHaveLength(0);
  });

  it("a restored Play-next queue starts at its first item on play", async () => {
    const r = rig();
    await r.coordinator.handleCommand({ kind: "insertNext", items: [appleItem("a"), appleItem("b")] });
    r.coordinator.dispose();
    const restored = new Coordinator({ registry: r.registry, store: r.store });
    cleanups.push(() => restored.dispose());
    expect(restored.getSnapshot().current).toBeNull();
    await restored.handleCommand({ kind: "play" });
    expect(restored.getSnapshot().current?.track.id).toBe("a");
    expect(restored.getSnapshot().status).toBe("playing");
    expect(r.page.evals.some(expression => expression.startsWith("window.__cadenceCtl.play("))).toBe(true);
  });

  it("advances a restored-near-tail Apple item after an incoming prepare fails", async () => {
    const r = rig();
    await r.coordinator.handleCommand({ kind: "setQueue", items: [appleItem("a"), fakeItem("b")], startIndex: 0 });
    await r.coordinator.handleCommand({ kind: "seek", positionMs: 179_000 });
    r.local.failPrepare = new Error("output unavailable");
    await r.coordinator.handleCommand({ kind: "next" });
    r.local.failPrepare = null;
    r.tick(1_500);
    r.emitPage("playerState", { state: "ended", ended: true, isAuthorized: true, positionMs: 180_000, durationMs: 180_000, nowPlayingId: "a" });
    await r.drain();
    expect(r.events.filter(event => event.kind === "trackEnded")).toHaveLength(1);
    expect(r.coordinator.getSnapshot().current?.track.id).toBe("b");
    expect(r.coordinator.getSnapshot().status).toBe("playing");
  });

  it("adopts Apple's synchronous promotion without replaying the item", async () => {
    const r = rig();
    await r.coordinator.handleCommand({ kind: "setQueue", items: [appleItem("a"), appleItem("b")], startIndex: 0 });
    await r.drain();
    r.tick(180_000);
    r.emitPage("nowPlaying", { id: "b", queuePos: 1 });
    await r.drain();
    expect(r.coordinator.getSnapshot().current?.track.id).toBe("b");
    expect(r.page.evals.filter(expr => expr.startsWith("window.__cadenceCtl.play("))).toHaveLength(1);
    expect(r.coordinator.getSnapshot().lease?.generationId).toBe(1);
  });

  it("sign-out during an in-flight play cannot resurrect the lease", async () => {
    const r = rig();
    let releasePlay: (value: boolean) => void = () => {};
    r.page.playGate = new Promise(resolve => { releasePlay = resolve; });
    const start = r.coordinator.handleCommand({ kind: "setQueue", items: [appleItem("a")], startIndex: 0 });
    for (let i = 0; i < 100 && !r.page.evals.some(expr => expr.startsWith("window.__cadenceCtl.play(")); i++) await Promise.resolve();
    expect(r.page.evals.some(expr => expr.startsWith("window.__cadenceCtl.play("))).toBe(true);
    await r.apple.signOut();
    releasePlay(true);
    await start;
    expect(r.coordinator.getSnapshot().lease).toBeNull();
    expect(r.coordinator.getSnapshot().status).toBe("stopped");
    expect(r.page.muted).toBe(true);
  });

  it("a normal persisted Apple position resumes on its second item", async () => {
    const r = rig();
    await r.coordinator.handleCommand({ kind: "setQueue", items: [appleItem("a"), appleItem("b")], startIndex: 1 });
    await r.coordinator.handleCommand({ kind: "seek", positionMs: 42_000 });
    r.coordinator.dispose();
    const registry = new AdapterRegistry();
    const apple = new FakeAdapter("apple-musickit");
    registry.register(apple);
    const restored = new Coordinator({ registry, store: r.store });
    cleanups.push(() => restored.dispose());
    expect(restored.getSnapshot().status).toBe("paused");
    expect(apple.playedItems).toHaveLength(0);
    await restored.handleCommand({ kind: "play" });
    expect(apple.playedItems[0]?.positionMs).toBe(42_000);
    expect(restored.getSnapshot().current?.track.id).toBe("b");
  });

  it("quit/restart during provider sign-in restores the queue without autoplay", async () => {
    const r = rig();
    await r.coordinator.handleCommand({ kind: "setQueue", items: [appleItem("a"), appleItem("b")], startIndex: 0 });
    // Park the sign-in flow inside its authorize() eval.
    let releaseAuth: (value: boolean) => void = () => {};
    r.page.authorizeGate = new Promise(resolve => { releaseAuth = resolve; });
    const signIn = r.apple.signIn();
    for (let i = 0; i < 50 && !r.page.evals.some(expr => expr.includes("authorize()")); i++) await Promise.resolve();
    expect(r.page.evals.some(expr => expr.includes("authorize()"))).toBe(true);
    // Quit while sign-in is in flight: dispose persists the playback section.
    r.coordinator.dispose();
    const restored = new Coordinator({ registry: r.registry, store: r.store });
    cleanups.push(() => restored.dispose());
    expect(restored.getQueue().items).toHaveLength(2);
    expect(restored.getSnapshot().status).toBe("paused");
    // The relaunch must not touch the provider engine — the only play eval
    // ever issued is the original one from setQueue.
    expect(r.page.evals.filter(expr => expr.startsWith("window.__cadenceCtl.play("))).toHaveLength(1);
    // Let the flow complete: auth resolves and the page reports authorized.
    releaseAuth(true);
    r.emitPage("playerState", { state: "paused", isAuthorized: true, positionMs: 0, durationMs: 0, nowPlayingId: null, queuePos: 0, queueLen: 0, nextItemId: null });
    await signIn;
  });

  it("native audio-service restart leaves provider playback owned and playing", async () => {
    const r = rig();
    const { spawn, services } = mockSpawnFactory();
    const client = new AudioServiceClient({ binaryPath: "/fake/cadence-audio", spawn, restart: { baseDelayMs: 1 } });
    // Exact callback wired to AudioServiceClient.onRestarted in main.ts.
    client.onRestarted(() => r.coordinator.notifyEngineRestarted(r.coordinator.activeRoute ?? "local"));
    await client.start();
    await r.coordinator.handleCommand({ kind: "setQueue", items: [fakeItem("local-a"), appleItem("a")], startIndex: 0 });
    await r.coordinator.handleCommand({ kind: "next" });
    const lease = r.coordinator.getSnapshot().lease;
    expect(lease?.route).toBe("apple-musickit");
    const before = r.page.evals.length;
    const restarted = new Promise<void>(resolve => client.onRestarted(resolve));
    services[0]!.crash();
    await restarted;
    await r.drain();
    await client.dispose();
    expect(services).toHaveLength(2);
    // The provider page is still sounding: the native service cannot stop it.
    expect(r.page.evals.slice(before).some(expression => expression.includes("pause()"))).toBe(false);
    expect(r.coordinator.getSnapshot().status).toBe("playing");
    expect(r.coordinator.getSnapshot().lease).toEqual(lease);
  });
});
