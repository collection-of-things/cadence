/**
 * Error ownership: a failure of an awaited adapter call is reported once —
 * by the call's rejection, which the coordinator turns into one error event.
 * Adapters must never also emit an `error` event for the same failure (that
 * produced two toasts for one click). See the note on RouteAdapter.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterEvent, CoordinatorEvent, PlaybackLease, QueueItem } from "@cadence/protocol";
import { AppleMusicKitAdapter } from "../src/adapters/providers/apple-musickit.js";
import { SpotifyLibrespotAdapter, type LibrespotGraph } from "../src/adapters/providers/spotify-librespot.js";
import { SpotifyWebAdapter } from "../src/adapters/providers/spotify-web.js";
import { YouTubeMusicAdapter } from "../src/adapters/providers/youtube-music.js";
import { LocalRouteAdapter } from "../src/adapters/local-route-adapter.js";
import { RouteError } from "../src/adapters/route-error.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { AudioServiceClient } from "../src/audio/audio-client.js";
import { Coordinator } from "../src/coordinator/coordinator.js";
import { SettingsStore } from "../src/coordinator/settings-store.js";
import { fakeItem } from "./fake-adapter.js";
import { mockSpawnFactory } from "./mock-audio-service.js";

vi.mock("electron", () => ({
  session: { fromPartition: () => ({ cookies: { get: async () => [] } }) },
  BrowserWindow: class {},
  webContents: {},
}));

const errorEvents = (events: AdapterEvent[]) => events.filter((e) => e.kind === "error");

function providerItem(route: QueueItem["track"]["route"], id: string): QueueItem {
  const item = fakeItem(id, route);
  return { ...item, track: { ...item.track, source: { kind: "provider", providerItemId: id } } };
}

const lease = (route: PlaybackLease["route"], queueId: string, generationId = 1): PlaybackLease => ({
  route,
  queueId,
  generationId,
  issuedAtMs: 0,
});

describe("provider adapters reject without also emitting an error", () => {
  it("YouTube Music: a failed play rejects once and emits nothing", async () => {
    const adapter = new YouTubeMusicAdapter();
    const events: AdapterEvent[] = [];
    Object.assign(adapter, {
      session: {
        prepare: async () => {},
        dispose: async () => {},
        setAudioMuted: () => {},
        eval: async (command: string) => {
          if (command.includes("isSignedIn()")) return true;
          if (command.includes("bootId")) return "page";
          if (command.startsWith("window.__cadenceCtl.play(")) throw new Error("video unavailable");
          return undefined;
        },
      },
    });
    adapter.onEvent((e) => events.push(e));
    const item = providerItem("youtube-music", "v1");
    const err = await adapter.play(item, lease("youtube-music", item.queueId), {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RouteError);
    expect((err as RouteError).message).toBe("YouTube Music play failed: video unavailable");
    expect(errorEvents(events)).toEqual([]);
    await adapter.dispose();
  });

  it("Spotify web: an unsigned build rejects with drm-unsigned and emits nothing", async () => {
    const adapter = new SpotifyWebAdapter();
    const events: AdapterEvent[] = [];
    Object.assign(adapter, { session: { setAudioMuted: () => {}, dispose: async () => {} } });
    adapter.onEvent((e) => events.push(e));
    const item = providerItem("spotify-web", "s1");
    const err = await adapter.play(item, lease("spotify-web", item.queueId)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RouteError);
    expect(err).toMatchObject({ code: "drm-unsigned", retriable: false });
    expect(errorEvents(events)).toEqual([]);
  });

  it("Spotify librespot: a missing engine rejects once and emits nothing", async () => {
    const graph = {} as LibrespotGraph;
    const adapter = new SpotifyLibrespotAdapter({ graph, binaryPath: "/nonexistent/librespot" });
    const events: AdapterEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    const item = providerItem("spotify-librespot", "s1");
    const err = await adapter.play(item, lease("spotify-librespot", item.queueId), {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RouteError);
    expect(err).toMatchObject({ retriable: false });
    expect(errorEvents(events)).toEqual([]);
  });
});

describe("Apple Music adapter auth surface", () => {
  function apple(authorized: boolean, resumeError?: Error) {
    const adapter = new AppleMusicKitAdapter();
    const events: AdapterEvent[] = [];
    Object.assign(adapter, {
      installed: true,
      authorized,
      session: {
        alive: true,
        prepare: async () => {},
        setAudioMuted: () => {},
        hasSessionCookies: async () => false,
        promoteCookie: async () => false,
        eval: async (expr: string) => {
          if (expr === "window.__cadenceCtl.isAuthorized()") return authorized;
          if (expr === "window.__cadenceCtl.resume()" && resumeError) throw resumeError;
          return true;
        },
      },
    });
    adapter.onEvent((e) => events.push(e));
    return { adapter, events };
  }

  it("reports canPlay only while authorized", async () => {
    expect((await apple(false).adapter.capabilities()).playback.canPlay).toBe(false);
    expect((await apple(true).adapter.capabilities()).playback.canPlay).toBe(true);
  });

  it("refuses the playback preflight while signed out, with a typed sign-in error", async () => {
    const err = await apple(false).adapter.prepare().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RouteError);
    expect(err).toMatchObject({ code: "unauthenticated", retriable: false });
  });

  it("still browses the catalog while signed out", async () => {
    const { adapter } = apple(false);
    const query = vi.fn(async () => ({ sections: [] }));
    Object.assign(adapter, { catalogService: { query } });
    await expect(adapter.catalog({ kind: "search", text: "x" } as never)).resolves.toEqual({ sections: [] });
    expect(query).toHaveBeenCalledOnce();
  });

  it("propagates a refused resume instead of swallowing it", async () => {
    const { adapter, events } = apple(false, new Error("Sign in to Apple Music to play full songs."));
    Object.assign(adapter, { generation: 4 });
    const err = await adapter.resume(lease("apple-musickit", "q", 4)).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "unauthenticated", retriable: false });
    expect(errorEvents(events)).toEqual([]);
  });
});

describe("local route load failures", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function rig(retryLoad = false) {
    const dir = mkdtempSync(join(tmpdir(), "cadence-errors-"));
    dirs.push(dir);
    const { spawn: rawSpawn, services } = mockSpawnFactory();
    const spawn = (_bin: string) => {
      const s = rawSpawn();
      for (const m of ["audio.play", "audio.pause", "audio.stop", "audio.setVolume", "audio.setFidelityMode", "audio.setReplayGain", "audio.prefetch", "audio.clearPrefetch"]) {
        s.handlers.set(m, () => ({ ok: true }));
      }
      // Like the Rust engine: emit event.error for the load, then fail the RPC.
      let loadCount = 0;
      s.handlers.set("audio.load", (p: { queueId: string; generationId: number }) => {
        if (retryLoad) {
          if (++loadCount > 1) return { ok: true, durationMs: 1000 };
          s.pushEvent("event.state", { generationId: p.generationId, state: "error" });
          s.pushEvent("event.error", { generationId: p.generationId, queueId: p.queueId,
            message: "stream rebuild in flight", retriable: true });
          return new Error("stream rebuild in flight");
        }
        s.pushEvent("event.error", { generationId: p.generationId, queueId: p.queueId, message: "unsupported codec", retriable: false });
        return new Error("unsupported codec");
      });
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
    const coordinator = new Coordinator({ registry, store: new SettingsStore(join(dir, "s.json")), persistDebounceMs: 0 });
    const events: CoordinatorEvent[] = [];
    coordinator.onEvent((e) => events.push(e));
    return { coordinator, events, services, client };
  }

  it("reports a failed load once", async () => {
    const r = rig();
    await r.coordinator.handleCommand({ kind: "setQueue", items: [fakeItem("a")], startIndex: 0 });
    await new Promise((res) => setTimeout(res, 30));
    const errs = r.events.filter((e) => e.kind === "error");
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ route: "local", message: "play failed: unsupported codec" });
    r.coordinator.dispose();
    await r.client.shutdown?.().catch(() => undefined);
  });

  it("keeps playback leased after a native load retries during a rebuild", async () => {
    const r = rig(true);
    await r.coordinator.handleCommand({ kind: "setQueue", items: [fakeItem("a")], startIndex: 0 });
    expect(r.services[0]!.methods().filter((method) => method === "audio.load")).toHaveLength(2);
    expect(r.services[0]!.methods()).not.toContain("audio.stop");
    expect(r.coordinator.getSnapshot()).toMatchObject({ status: "playing", lease: { generationId: 1 } });
    expect(r.events.filter((e) => e.kind === "error")).toHaveLength(0);
    r.coordinator.dispose();
    await r.client.shutdown?.().catch(() => undefined);
  });

  it("still forwards an unsolicited engine error", async () => {
    const r = rig();
    await r.coordinator.handleCommand({ kind: "setQueue", items: [fakeItem("a")], startIndex: 0 });
    await new Promise((res) => setTimeout(res, 30));
    r.events.length = 0;
    r.services[0]!.pushEvent("event.error", { generationId: 1, message: "output device lost: unplugged", retriable: false });
    await new Promise((res) => setTimeout(res, 30));
    expect(r.events.filter((e) => e.kind === "error")).toEqual([
      { kind: "error", route: "local", message: "output device lost: unplugged", retriable: false },
    ]);
    r.coordinator.dispose();
    await r.client.shutdown?.().catch(() => undefined);
  });
});
