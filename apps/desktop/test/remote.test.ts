import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type {
  CoordinatorEvent,
  PlaybackCommand,
  PlaybackSnapshot,
  QueueState,
  RemotePairResponse,
  RemoteServerMessage,
  RemoteStatus,
  TrackRef,
} from "@cadence/protocol";
import { SettingsStore } from "../src/coordinator/settings-store.js";
import { PAIRING_MAX_ATTEMPTS, RemoteDevices } from "../src/remote/remote-devices.js";
import { RemoteService, parseRange } from "../src/remote/remote-service.js";

const track: TrackRef = {
  id: "local:abc",
  route: "local",
  provider: "local",
  title: "North Field",
  artists: [{ name: "Field Notes" }],
  durationMs: 1000,
  source: { kind: "file", path: "" },
  artwork: { url: "cadence-art://artwork/%2Fthumbs%2Fabc.png" },
  availability: "available",
};

class FakeCoordinator {
  readonly commands: PlaybackCommand[] = [];
  private readonly listeners = new Set<(e: CoordinatorEvent) => void>();
  onEvent(cb: (e: CoordinatorEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(e: CoordinatorEvent): void {
    for (const cb of this.listeners) cb(e);
  }
  getSnapshot(): PlaybackSnapshot {
    return {
      status: this.status,
      lease: null,
      current: { queueId: "q1", track },
      positionMs: 400,
      positionAtMs: 1,
      durationMs: 1000,
      volume: 1,
      muted: false,
    };
  }
  getQueue(): QueueState {
    return { owner: "coordinator", items: [{ queueId: "q1", track }], currentIndex: 0, shuffle: false, repeat: "off" };
  }
  status: PlaybackSnapshot["status"] = "playing";
  async handleCommand(cmd: PlaybackCommand): Promise<void> {
    this.commands.push(cmd);
    if (cmd.kind === "pause") this.setStatus("paused");
    if (cmd.kind === "play") this.setStatus("playing");
  }
  setStatus(status: PlaybackSnapshot["status"]): void {
    this.status = status;
    this.emit({ kind: "snapshot", snapshot: this.getSnapshot() });
  }
}

let dir: string;
let audioPath: string;
let store: SettingsStore;
let coordinator: FakeCoordinator;
let service: RemoteService;
let base: string;

async function startService(): Promise<RemoteStatus> {
  const status = await service.setEnabled(true);
  if (status.server.kind !== "on") throw new Error(`server did not start: ${JSON.stringify(status.server)}`);
  base = `http://127.0.0.1:${status.server.port}`;
  return status;
}

async function pair(): Promise<RemotePairResponse> {
  const status = await service.startPairing();
  const code = status.pairing?.code ?? "";
  const res = await fetch(`${base}/v1/pair`, {
    method: "POST",
    body: JSON.stringify({ code, deviceName: "Test\u0007 Phone" }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as RemotePairResponse;
}

function openSocket(token: string): Promise<{ ws: WebSocket; messages: RemoteServerMessage[] }> {
  const ws = new WebSocket(`${base.replace("http", "ws")}/v1/live?t=${token}`);
  const messages: RemoteServerMessage[] = [];
  ws.on("message", (d) => messages.push(JSON.parse(String(d)) as RemoteServerMessage));
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, messages }));
    ws.once("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    ws.once("error", reject);
  });
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cadence-remote-"));
  audioPath = join(dir, "song.flac");
  writeFileSync(audioPath, Buffer.from("0123456789"));
  writeFileSync(join(dir, "cover.png"), Buffer.from("png"));
  store = new SettingsStore(join(dir, "settings.json"));
  store.saveSection("remote", { port: 0 });
  coordinator = new FakeCoordinator();
  service = new RemoteService({
    devices: new RemoteDevices({ store }),
    coordinator,
    mediaFile: (id) => (id === track.id ? audioPath : null),
    artworkFile: (id) => (id === track.id ? join(dir, "cover.png") : null),
    hostName: "test-host",
    appVersion: "0.0.0",
    renderQr: async (text) => `<svg>${text}</svg>`,
    listAddresses: () => ["127.0.0.1"],
    bindHost: "127.0.0.1",
  });
});

afterEach(async () => {
  await service.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("parseRange", () => {
  it("parses open, closed and suffix ranges", () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange("bytes=2-", 10)).toEqual({ start: 2, end: 9 });
    expect(parseRange("bytes=2-4", 10)).toEqual({ start: 2, end: 4 });
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=5-99", 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange("bytes=10-", 10)).toBe("unsatisfiable");
  });
});

describe("RemoteService", () => {
  it("serves host info without auth and stays off until enabled", async () => {
    expect(service.status().server.kind).toBe("off");
    await startService();
    const info = (await (await fetch(`${base}/v1/info`)).json()) as { name: string; app: string };
    expect(info).toMatchObject({ app: "cadence", name: "test-host" });
  });

  it("pairs with the shown code, then refuses a second use of it", async () => {
    await startService();
    const status = await service.startPairing();
    expect(status.pairing?.link).toContain("cadence://pair?");
    const code = status.pairing?.code ?? "";
    const res = await fetch(`${base}/v1/pair`, {
      method: "POST",
      body: JSON.stringify({ code, deviceName: "Phone" }),
    });
    expect(res.status).toBe(200);
    expect(service.status().pairing).toBeNull();
    const again = await fetch(`${base}/v1/pair`, {
      method: "POST",
      body: JSON.stringify({ code, deviceName: "Phone" }),
    });
    expect(again.status).toBe(403);
  });

  it("closes pairing after too many wrong codes", async () => {
    await startService();
    const status = await service.startPairing();
    const wrong = status.pairing?.code === "000000" ? "111111" : "000000";
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i++) {
      const res = await fetch(`${base}/v1/pair`, {
        method: "POST",
        body: JSON.stringify({ code: wrong, deviceName: "Phone" }),
      });
      expect(res.status).toBe(403);
    }
    expect(service.status().pairing).toBeNull();
  });

  it("streams library files with Range and rejects unpaired requests", async () => {
    await startService();
    const { token } = await pair();
    expect((await fetch(`${base}/v1/media/${encodeURIComponent(track.id)}`)).status).toBe(401);
    const res = await fetch(`${base}/v1/media/${encodeURIComponent(track.id)}`, {
      headers: { Authorization: `Bearer ${token}`, Range: "bytes=2-4" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(res.headers.get("content-type")).toBe("audio/flac");
    expect(await res.text()).toBe("234");
    const missing = await fetch(`${base}/v1/media/local%3Aother?t=${token}`);
    expect(missing.status).toBe(404);
    const art = await fetch(`${base}/v1/artwork/${encodeURIComponent(track.id)}?t=${token}`);
    expect(await art.text()).toBe("png");
  });

  it("sends hello with LAN artwork, forwards events but not FFT, and filters commands", async () => {
    await startService();
    const { token, deviceId } = await pair();
    expect(service.status().devices[0]?.name).toBe("Test Phone");
    const { ws, messages } = await openSocket(token);
    await until(() => messages.length > 0);
    const hello = messages[0];
    if (hello?.kind !== "hello") throw new Error("expected hello first");
    expect(hello.deviceId).toBe(deviceId);
    expect(hello.snapshot.current?.track.artwork?.url).toBe("/v1/artwork/local%3Aabc");
    expect(service.status().devices[0]?.online).toBe(true);

    coordinator.emit({ kind: "fft", bands: [], peak: 0, atMs: 0, generationId: 1 });
    coordinator.emit({ kind: "position", positionMs: 500, atMs: 2, generationId: 1 });
    await until(() => messages.some((m) => m.kind === "event"));
    expect(messages[1]).toMatchObject({ kind: "session", activeDeviceId: null });
    expect(messages.filter((m) => m.kind === "event")).toEqual([
      expect.objectContaining({ event: expect.objectContaining({ kind: "position", positionMs: 500 }) }),
    ]);

    ws.send(JSON.stringify({ kind: "command", command: { kind: "pause" } }));
    ws.send(JSON.stringify({ kind: "command", command: { kind: "setQueue", items: [] } }));
    await until(() => coordinator.commands.length === 1 && messages.some((m) => m.kind === "error"));
    expect(coordinator.commands).toEqual([{ kind: "pause" }]);
    ws.close();
  });

  it("revoking a device drops its socket and its token", async () => {
    await startService();
    const { token, deviceId } = await pair();
    const { ws } = await openSocket(token);
    const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
    service.revoke(deviceId);
    expect(await closed).toBe(4001);
    await expect(openSocket(token)).rejects.toThrow("status 401");
  });

  it("keeps paired devices across a restart", async () => {
    await startService();
    const { token } = await pair();
    await service.setEnabled(false);
    expect(service.status().server.kind).toBe("off");
    const reloaded = new RemoteDevices({ store });
    expect(reloaded.authenticate(token)?.name).toBe("Test Phone");
    expect(reloaded.authenticate("nope")).toBeNull();
  });
});

describe("playback ownership", () => {
  const report = { queueId: "q1", playing: true, positionMs: 30_000, durationMs: 1000_000, volume: 1 };

  it("a phone report takes ownership, pauses the computer, and routes transport to the phone", async () => {
    await startService();
    const { token } = await pair();
    const { ws, messages } = await openSocket(token);
    await until(() => messages.some((m) => m.kind === "session"));
    ws.send(JSON.stringify({ kind: "output", output: report }));
    await until(() => service.status().activeOutput !== null);
    expect(service.status().activeOutput).toMatchObject({ queueId: "q1", deviceName: "Test Phone", playing: true });
    expect(coordinator.commands).toContainEqual({ kind: "pause" });
    expect(messages.some((m) => m.kind === "session" && m.activeDeviceId !== null)).toBe(true);

    expect(service.routeCommand({ kind: "pause" })).toBe(true);
    expect(service.status().activeOutput?.playing).toBe(false);
    expect(service.routeCommand({ kind: "setShuffle", shuffle: true })).toBe(false);
    await until(() => messages.some((m) => m.kind === "control" && m.command.kind === "pause"));

    ws.send(JSON.stringify({ kind: "release" }));
    await until(() => service.status().activeOutput === null);
    expect(service.routeCommand({ kind: "pause" })).toBe(false);
    ws.close();
  });

  it("pressing play on the computer stops the phone", async () => {
    await startService();
    const { token } = await pair();
    const { ws, messages } = await openSocket(token);
    ws.send(JSON.stringify({ kind: "output", output: report }));
    await until(() => service.status().activeOutput !== null && coordinator.status === "paused");
    coordinator.setStatus("playing");
    await until(() => service.status().activeOutput === null);
    await until(() => messages.some((m) => m.kind === "control" && m.command.kind === "stop"));
    ws.close();
  });

  it("reclaim stops the phone and resumes the computer at the phone's position", async () => {
    await startService();
    const { token } = await pair();
    const { ws, messages } = await openSocket(token);
    ws.send(JSON.stringify({ kind: "output", output: { ...report, playing: false } }));
    await until(() => service.status().activeOutput !== null);
    coordinator.commands.length = 0;
    await service.reclaim();
    expect(coordinator.commands).toEqual([
      { kind: "play", queueId: "q1" },
      { kind: "seek", positionMs: 30_000 },
    ]);
    expect(service.status().activeOutput).toBeNull();
    await until(() => messages.some((m) => m.kind === "control" && m.command.kind === "stop"));
    ws.close();
  });

  it("handoff asks an online phone to take over at the current item", async () => {
    await startService();
    const { token, deviceId } = await pair();
    expect(() => service.handoff(deviceId)).toThrow("not connected");
    const { ws, messages } = await openSocket(token);
    await until(() => service.status().devices[0]?.online === true);
    service.handoff(deviceId);
    await until(() => messages.some((m) => m.kind === "handoff"));
    expect(messages.find((m) => m.kind === "handoff")).toMatchObject({ queueId: "q1" });
    ws.close();
  });

  it("rejects malformed reports and drops ownership when the phone disconnects", async () => {
    await startService();
    const { token } = await pair();
    const { ws, messages } = await openSocket(token);
    ws.send(JSON.stringify({ kind: "output", output: { queueId: "q1" } }));
    await until(() => messages.some((m) => m.kind === "error"));
    ws.send(JSON.stringify({ kind: "output", output: report }));
    await until(() => service.status().activeOutput !== null);
    ws.close();
    await until(() => service.status().activeOutput === null);
  });

  it("announces on mDNS while on and stops when off", async () => {
    const announced: number[] = [];
    let stopped = 0;
    service = new RemoteService({
      devices: new RemoteDevices({ store }),
      coordinator,
      mediaFile: () => null,
      artworkFile: () => null,
      hostName: "test-host",
      appVersion: "0.0.0",
      renderQr: async (t) => t,
      listAddresses: () => ["127.0.0.1"],
      bindHost: "127.0.0.1",
      advertise: ({ port }) => {
        announced.push(port);
        return () => {
          stopped += 1;
        };
      },
    });
    await startService();
    expect(announced).toHaveLength(1);
    await service.setEnabled(false);
    expect(stopped).toBe(1);
  });
});
