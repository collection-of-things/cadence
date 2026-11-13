import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type {
  CoordinatorEvent,
  PlaybackCommand,
  PlaybackSnapshot,
  QueueItem,
  QueueState,
  RemoteClientMessage,
  RemotePairResponse,
  RemoteServerMessage,
  TrackRef,
} from "@cadence/protocol";
// The phone app's real ownership logic, driven against the real desktop service.
import { PhoneRemote, type OwnershipLink, type OwnershipPlayer } from "../../mobile/src/phoneRemote.ts";
import { SettingsStore } from "../src/coordinator/settings-store.js";
import { RemoteDevices } from "../src/remote/remote-devices.js";
import { RemoteService } from "../src/remote/remote-service.js";

function makeTrack(id: string, source: TrackRef["source"], route: TrackRef["route"] = "local"): TrackRef {
  return {
    id,
    route,
    provider: route === "local" ? "local" : "spotify",
    title: id,
    artists: [{ name: "Field Notes" }],
    durationMs: 200_000,
    source,
    availability: "available",
  } as TrackRef;
}

const items: QueueItem[] = [
  { queueId: "q1", track: makeTrack("local:a", { kind: "file", path: "/a.flac" }) },
  { queueId: "q2", track: makeTrack("local:b", { kind: "file", path: "/b.flac" }) },
];

class FakeCoordinator {
  readonly commands: PlaybackCommand[] = [];
  status: PlaybackSnapshot["status"] = "playing";
  currentQueueId = "q1";
  queue: QueueItem[] = items;
  private readonly listeners = new Set<(e: CoordinatorEvent) => void>();
  onEvent(cb: (e: CoordinatorEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  getSnapshot(): PlaybackSnapshot {
    return {
      status: this.status,
      lease: null,
      current: this.queue.find((i) => i.queueId === this.currentQueueId) ?? null,
      positionMs: 40_000,
      positionAtMs: Date.now(),
      durationMs: 200_000,
      volume: 1,
      muted: false,
    };
  }
  getQueue(): QueueState {
    return { owner: "coordinator", items: this.queue, currentIndex: 0, shuffle: false, repeat: "off" };
  }
  async handleCommand(cmd: PlaybackCommand): Promise<void> {
    this.commands.push(cmd);
    if (cmd.kind === "pause") this.setStatus("paused");
    if (cmd.kind === "play" || cmd.kind === "resume") {
      if (cmd.kind === "play" && cmd.queueId !== undefined) this.currentQueueId = cmd.queueId;
      this.setStatus("playing");
    }
  }
  setStatus(status: PlaybackSnapshot["status"]): void {
    this.status = status;
    for (const cb of this.listeners) cb({ kind: "snapshot", snapshot: this.getSnapshot() });
  }
}

interface FakeState {
  active: boolean;
  playing: boolean;
  positionMs: number;
  durationMs: number;
}

/** A phone audio player that only plays when the test says the source loaded. */
class FakePlayer implements OwnershipPlayer {
  state: FakeState = { active: false, playing: false, positionMs: 0, durationMs: 0 };
  readonly calls: string[] = [];
  failLoads = false;
  private queue: QueueItem[] = [];
  private index = -1;
  private vol = 1;
  private readonly listeners = new Set<() => void>();

  getState = (): FakeState => this.state;
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  private set(patch: Partial<FakeState>): void {
    this.state = { ...this.state, ...patch };
    for (const cb of this.listeners) cb();
  }
  async start(p: { items: QueueItem[]; index: number; positionMs: number }): Promise<void> {
    this.calls.push(`start:${p.items[p.index]?.queueId}@${Math.round(p.positionMs)}`);
    this.queue = p.items;
    this.index = p.index;
    this.set({ active: true, playing: false, positionMs: p.positionMs, durationMs: 200_000 });
  }
  /** The source finished loading and audio started. */
  finishLoading(): void {
    if (!this.failLoads && this.state.active) this.set({ playing: true });
  }
  tick(positionMs: number): void {
    this.set({ positionMs });
  }
  current = (): QueueItem | null => this.queue[this.index] ?? null;
  volume = (): number => this.vol;
  resume(): void {
    this.calls.push("resume");
    this.set({ playing: true });
  }
  pause(): void {
    this.calls.push("pause");
    this.set({ playing: false });
  }
  next(): void {
    this.calls.push("next");
    if (this.index + 1 < this.queue.length) {
      this.index += 1;
      this.set({ positionMs: 0, playing: true });
    }
  }
  previous(): void {
    this.calls.push("previous");
  }
  seek(positionMs: number): void {
    this.calls.push(`seek:${positionMs}`);
    this.set({ positionMs });
  }
  setVolume(volume: number): void {
    this.calls.push(`volume:${volume}`);
    this.vol = volume;
  }
  playQueueId(queueId: string): boolean {
    const i = this.queue.findIndex((it) => it.queueId === queueId);
    if (i < 0) return false;
    this.calls.push(`play:${queueId}`);
    this.index = i;
    this.set({ positionMs: 0, playing: true });
    return true;
  }
  stop(): void {
    this.calls.push("stop");
    this.queue = [];
    this.index = -1;
    this.set({ active: false, playing: false, positionMs: 0 });
  }
}

/** A DesktopLink stand-in over a real WebSocket: mirrors hello/events, feeds messages to PhoneRemote. */
class PhoneLink implements OwnershipLink {
  readonly sent: RemoteClientMessage[] = [];
  readonly received: RemoteServerMessage[] = [];
  readonly notes: string[] = [];
  readonly remote: PhoneRemote;
  token = "";
  private ws!: WebSocket;
  private snapshot: PlaybackSnapshot | null = null;
  private queue: QueueState | null = null;
  private connection: "connecting" | "online" | "offline" = "connecting";

  constructor(
    private readonly base: string,
    readonly player: FakePlayer,
    takeoverTimeoutMs = 10_000,
  ) {
    this.remote = new PhoneRemote(this, player, (m) => this.notes.push(m), Date.now, takeoverTimeoutMs);
  }

  getState() {
    return { connection: this.connection, base: this.base, queue: this.queue, snapshot: this.snapshot };
  }

  sendMessage(msg: RemoteClientMessage): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    this.sent.push(msg);
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  connect(token: string): Promise<void> {
    this.token = token;
    this.ws = new WebSocket(`${this.base.replace("http", "ws")}/v1/live?t=${token}`);
    this.ws.on("message", (d) => {
      const msg = JSON.parse(String(d)) as RemoteServerMessage;
      this.received.push(msg);
      if (msg.kind === "hello") {
        this.connection = "online";
        this.snapshot = msg.snapshot;
        this.queue = msg.queue;
      } else if (msg.kind === "event" && msg.event.kind === "snapshot") this.snapshot = msg.event.snapshot;
      this.remote.handle(msg);
    });
    this.ws.on("close", () => {
      this.connection = "offline";
    });
    return until(() => this.connection === "online" && this.received.some((m) => m.kind === "session"));
  }

  drop(): void {
    this.ws.close();
  }

  raw(msg: RemoteClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }
}

let dir: string;
let coordinator: FakeCoordinator;
let service: RemoteService;
let base: string;
let phones: PhoneLink[];

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 80));
}

async function pairedPhone(player = new FakePlayer(), takeoverTimeoutMs?: number): Promise<{ phone: PhoneLink; deviceId: string; token: string }> {
  const status = await service.startPairing();
  const res = await fetch(`${base}/v1/pair`, {
    method: "POST",
    body: JSON.stringify({ code: status.pairing?.code ?? "", deviceName: "Test Phone" }),
  });
  const { token, deviceId } = (await res.json()) as RemotePairResponse;
  const phone = new PhoneLink(base, player, takeoverTimeoutMs);
  phones.push(phone);
  await phone.connect(token);
  return { phone, deviceId, token };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "cadence-handoff-"));
  const store = new SettingsStore(join(dir, "settings.json"));
  store.saveSection("remote", { port: 0 });
  coordinator = new FakeCoordinator();
  phones = [];
  service = new RemoteService({
    devices: new RemoteDevices({ store }),
    coordinator,
    mediaFile: () => null,
    artworkFile: () => null,
    hostName: "test-host",
    appVersion: "0.0.0",
    renderQr: async (text) => `<svg>${text}</svg>`,
    listAddresses: () => ["127.0.0.1"],
    bindHost: "127.0.0.1",
  });
  const status = await service.setEnabled(true);
  if (status.server.kind !== "on") throw new Error("server did not start");
  base = `http://127.0.0.1:${status.server.port}`;
});

afterEach(async () => {
  for (const p of phones) p.remote.dispose();
  await service.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("desktop-initiated handoff", () => {
  it("the phone starts at the desktop's item and position, and the computer pauses once the phone really plays", async () => {
    const { phone, deviceId } = await pairedPhone();
    service.handoff(deviceId);
    await until(() => phone.player.calls.length > 0);
    expect(phone.player.calls[0]).toMatch(/^start:q1@/);

    await settle();
    expect(coordinator.status).toBe("playing");
    expect(service.status().activeOutput).toBeNull();

    phone.player.finishLoading();
    await until(() => service.status().activeOutput !== null);
    expect(service.status().activeOutput).toMatchObject({ queueId: "q1", playing: true, deviceId });
    await until(() => coordinator.status === "paused");
    expect(phone.received.some((m) => m.kind === "session" && m.activeDeviceId === deviceId)).toBe(true);
  });

  it("a handoff for a song the phone cannot stream leaves the computer playing", async () => {
    coordinator.queue = [{ queueId: "q1", track: makeTrack("spotify:x", { kind: "provider", providerItemId: "x" }, "spotify-web") }];
    const { phone, deviceId } = await pairedPhone();
    service.handoff(deviceId);
    await until(() => phone.notes.length > 0);
    expect(phone.player.calls).toEqual([]);
    expect(coordinator.status).toBe("playing");
    expect(service.status().activeOutput).toBeNull();
  });

  it("a handoff whose track never loads times out without pausing the computer", async () => {
    const { phone, deviceId } = await pairedPhone(new FakePlayer(), 60);
    phone.player.failLoads = true;
    service.handoff(deviceId);
    await until(() => phone.player.calls.includes("stop"));
    expect(phone.notes.at(-1)).toMatch(/could not start/);
    expect(phone.sent.some((m) => m.kind === "output")).toBe(false);
    expect(coordinator.status).toBe("playing");
    expect(service.status().activeOutput).toBeNull();
  });
});

describe("phone takeover and control", () => {
  async function owned() {
    const ctx = await pairedPhone();
    expect(await ctx.phone.remote.takeOver()).toBe("started");
    ctx.phone.player.finishLoading();
    await until(() => service.status().activeOutput !== null && coordinator.status === "paused");
    return ctx;
  }

  it("takeover pauses the computer only after the phone reports, and does not send a desktop pause itself", async () => {
    const { phone } = await owned();
    expect(phone.sent.some((m) => m.kind === "command")).toBe(false);
    expect(coordinator.commands.filter((c) => c.kind === "pause")).toHaveLength(1);
  });

  it("desktop transport reaches the phone-owned session and its reports come back", async () => {
    const { phone } = await owned();
    expect(service.routeCommand({ kind: "pause" })).toBe(true);
    await until(() => phone.player.calls.includes("pause"));
    await until(() => service.status().activeOutput?.playing === false);

    expect(service.routeCommand({ kind: "seek", positionMs: 90_000 })).toBe(true);
    await until(() => phone.player.calls.includes("seek:90000"));
    await until(() => Math.round(service.status().activeOutput?.positionMs ?? 0) === 90_000);

    expect(service.routeCommand({ kind: "setVolume", volume: 0.25 })).toBe(true);
    await until(() => phone.player.calls.includes("volume:0.25"));
    await until(() => service.status().activeOutput?.volume === 0.25);

    expect(service.routeCommand({ kind: "next" })).toBe(true);
    await until(() => service.status().activeOutput?.queueId === "q2");

    expect(service.routeCommand({ kind: "play", queueId: "q1" })).toBe(true);
    await until(() => service.status().activeOutput?.queueId === "q1");
    expect(coordinator.commands.filter((c) => c.kind === "next" || c.kind === "seek")).toEqual([]);
  });

  it("a control for a song missing from the phone's queue is refused, not guessed", async () => {
    const { phone } = await owned();
    expect(service.routeCommand({ kind: "play", queueId: "gone" })).toBe(true);
    await until(() => phone.notes.length > 0);
    expect(service.status().activeOutput?.queueId).toBe("q1");
  });

  it("a second phone taking over stops the first", async () => {
    const a = await owned();
    const b = await pairedPhone();
    await b.phone.remote.takeOver();
    b.phone.player.finishLoading();
    await until(() => service.status().activeOutput?.deviceId === b.deviceId);
    await until(() => !a.phone.player.getState().active);
    expect(a.phone.sent.at(-1)).toEqual({ kind: "release" });
    expect(service.status().activeOutput?.deviceId).toBe(b.deviceId);
  });
});

describe("handback and competing owners", () => {
  async function owned() {
    const ctx = await pairedPhone();
    await ctx.phone.remote.takeOver();
    ctx.phone.player.finishLoading();
    await until(() => service.status().activeOutput !== null && coordinator.status === "paused");
    return ctx;
  }

  it("the phone letting go releases ownership, so a following play is not treated as a competing owner", async () => {
    const { phone } = await owned();
    phone.player.stop();
    await until(() => service.status().activeOutput === null);
    phone.raw({ kind: "command", command: { kind: "play", queueId: "q1" } });
    await until(() => coordinator.status === "playing");
    await settle();
    expect(phone.received.filter((m) => m.kind === "control")).toEqual([]);
    expect(service.status().activeOutput).toBeNull();
  });

  it("pressing play on the computer stops the phone, which then releases", async () => {
    const { phone } = await owned();
    coordinator.setStatus("playing");
    await until(() => !phone.player.getState().active);
    await until(() => phone.sent.some((m) => m.kind === "release"));
    expect(service.status().activeOutput).toBeNull();
  });

  it("reclaim stops the phone, and a report already in flight does not take ownership back", async () => {
    const { phone } = await owned();
    await service.reclaim();
    expect(coordinator.status).toBe("playing");
    phone.raw({ kind: "output", output: { queueId: "q1", playing: true, positionMs: 41_000, durationMs: 200_000, volume: 1 } });
    await settle();
    expect(service.status().activeOutput).toBeNull();
    expect(coordinator.status).toBe("playing");
    await until(() => !phone.player.getState().active);
    await until(() => phone.sent.some((m) => m.kind === "release"));
  });

  it("the phone can take over again after a reclaim", async () => {
    const { phone } = await owned();
    await service.reclaim();
    await until(() => phone.sent.some((m) => m.kind === "release"));
    await phone.remote.takeOver();
    phone.player.finishLoading();
    await until(() => service.status().activeOutput !== null);
  });
});

describe("disconnect", () => {
  it("the computer drops a vanished phone, and the phone re-announces when it comes back and the computer is idle", async () => {
    const { phone, token, deviceId } = await (async () => {
      const ctx = await pairedPhone();
      await ctx.phone.remote.takeOver();
      ctx.phone.player.finishLoading();
      await until(() => service.status().activeOutput !== null);
      return ctx;
    })();
    phone.drop();
    await until(() => service.status().activeOutput === null);
    expect(coordinator.status).toBe("paused");

    const back = new PhoneLink(base, phone.player);
    phones.push(back);
    await back.connect(token);
    await until(() => service.status().activeOutput?.deviceId === deviceId);
    expect(phone.player.getState().active).toBe(true);
  });

  it("a phone that comes back while the computer is playing steps aside", async () => {
    const ctx = await pairedPhone();
    await ctx.phone.remote.takeOver();
    ctx.phone.player.finishLoading();
    await until(() => service.status().activeOutput !== null);
    ctx.phone.drop();
    await until(() => service.status().activeOutput === null);
    coordinator.setStatus("playing");

    const back = new PhoneLink(base, ctx.phone.player);
    phones.push(back);
    await back.connect(ctx.token);
    await until(() => !ctx.phone.player.getState().active);
    expect(service.status().activeOutput).toBeNull();
    expect(coordinator.status).toBe("playing");
  });
});
