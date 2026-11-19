import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AdapterEvent, TrackRef } from "@cadence/protocol";
import { normalizeHit, bestThumb } from "../src/adapters/providers/youtube-music-catalog.js";
import { YouTubeMusicAdapter } from "../src/adapters/providers/youtube-music.js";
import { SpotifyLibrespotAdapter, type LibrespotGraph } from "../src/adapters/providers/spotify-librespot.js";

// The adapter imports ProviderSession which touches electron; the cookie
// partition is stubbed since search tests inject the catalog anyway.
vi.mock("electron", () => ({
  session: {
    fromPartition: () => ({ cookies: { get: async () => [] } }),
  },
  BrowserWindow: class {},
  webContents: {},
}));

const graph: LibrespotGraph = {
  openStream: async () => ({
    streamId: "s1",
    write: async () => {},
    end: async () => {},
    abort: async () => {},
  }),
  play: async () => {},
  pause: async () => {},
  stop: async () => {},
  setVolume: async () => {},
};

describe("youtube-music-catalog normalizeHit", () => {
  it("maps an InnerTube song result to a hit", () => {
    const hit = normalizeHit({
      video_id: "abc123",
      title: { text: "Song Title" },
      subtitle: { text: "Artist One, Artist Two • Album Name" },
      duration: { seconds: 213 },
      thumbnails: [
        { url: "https://i/small.jpg", width: 60, height: 60 },
        { url: "https://i/large.jpg", width: 544, height: 544 },
      ],
    });
    expect(hit).not.toBeNull();
    expect(hit!.videoId).toBe("abc123");
    expect(hit!.title).toBe("Song Title");
    expect(hit!.durationMs).toBe(213000);
    expect(bestThumb(hit!.thumbnails!).url).toBe("https://i/large.jpg");
  });

  it("returns null without a video id", () => {
    expect(normalizeHit({ title: "x" })).toBeNull();
  });
});

describe("youtube-music adapter", () => {
  const hit: TrackRef = {
    id: "youtube-music:abc123",
    route: "youtube-music",
    provider: "youtube",
    title: "Song Title",
    artists: [{ name: "Artist One" }],
    durationMs: 213_000,
    source: { kind: "provider", providerItemId: "abc123" },
    availability: "unknown",
  };

  it("delegates to the injected catalog and returns TrackRefs", async () => {
    const calls: string[] = [];
    const adapter = new YouTubeMusicAdapter({
      catalog: {
        searchTracks: async (q) => {
          calls.push(q);
          return [hit];
        },
      },
    });
    const out = await adapter.search("  tessellate  ");
    expect(calls).toEqual(["tessellate"]);
    expect(out).toEqual([hit]);
    await adapter.dispose();
  });

  it("wraps catalog failures with the real cause", async () => {
    const adapter = new YouTubeMusicAdapter({
      catalog: {
        searchTracks: async () => {
          throw new Error("innertube exploded");
        },
      },
    });
    await expect(adapter.search("x")).rejects.toThrow(
      "YouTube Music search failed: innertube exploded",
    );
    await adapter.dispose();
  });

  it("returns [] for blank queries without touching the catalog", async () => {
    let called = false;
    const adapter = new YouTubeMusicAdapter({
      catalog: {
        searchTracks: async () => {
          called = true;
          return [];
        },
      },
    });
    expect(await adapter.search("   ")).toEqual([]);
    expect(called).toBe(false);
    await adapter.dispose();
  });

  it("starts the reloaded view at the saved volume and reports a pre-roll as buffering", async () => {
    const adapter = new YouTubeMusicAdapter();
    const events: AdapterEvent[] = [];
    const attempts: { muted: boolean; command: string }[] = [];
    let bootId = "first";
    let muted = false;
    Object.assign(adapter, {
      session: {
        prepare: async () => {},
        dispose: async () => {},
        setAudioMuted: (value: boolean) => { muted = value; },
        eval: async (command: string) => {
          if (command.includes("isSignedIn()")) return true;
          if (command.includes("bootId")) return bootId;
          if (!command.startsWith("window.__cadenceCtl.play(")) return undefined;
          attempts.push({ muted, command });
          if (bootId === "first") {
            bootId = "reloaded";
            return "reloading";
          }
          return { bootId, generationId: 2, state: "buffering", positionMs: 0 };
        },
      },
    });
    adapter.onEvent((event) => events.push(event));
    await adapter.setVolume(0);
    await adapter.play({ track: hit, queueId: "q" }, {
      route: "youtube-music", queueId: "q", generationId: 2, issuedAtMs: 0,
    }, {});

    expect(attempts).toEqual(Array.from({ length: 2 }, () => ({
      muted: true,
      command: 'window.__cadenceCtl.play(...["abc123",0,2,0])',
    })));
    expect(muted).toBe(false);
    expect(events.filter((event) => event.kind === "started" || event.kind === "state")).toEqual([
      { kind: "started", generationId: 2, durationMs: 213_000 },
      { kind: "state", generationId: 2, status: "buffering" },
    ]);
    await adapter.dispose();
  });

  it("does not report a playback error after stopping a pending play", async () => {
    const adapter = new YouTubeMusicAdapter();
    const events: AdapterEvent[] = [];
    let signalPlay = () => {};
    const playing = new Promise<void>((resolve) => { signalPlay = resolve; });
    let rejectPlay = (_error: Error) => {};
    Object.assign(adapter, {
      session: {
        prepare: async () => {},
        dispose: async () => {},
        setAudioMuted: () => {},
        eval: async (command: string) => {
          if (command.includes("isSignedIn()")) return true;
          if (command.includes("bootId")) return "page";
          if (command.startsWith("window.__cadenceCtl.play(")) {
            return new Promise((_resolve, reject) => {
              rejectPlay = reject;
              signalPlay();
            });
          }
          if (command.endsWith(".stop()")) rejectPlay(new DOMException("Playback interrupted", "AbortError"));
          return undefined;
        },
      },
    });
    adapter.onEvent((event) => events.push(event));
    const lease = { route: "youtube-music" as const, queueId: "q", generationId: 1, issuedAtMs: 0 };
    const attempt = adapter.play({ track: hit, queueId: "q" }, lease, {});
    await playing;
    await adapter.stop(lease);

    const outcome = await attempt.then(() => "stopped", () => "failed");
    expect(outcome).toBe("stopped");
    expect(events.some((event) => event.kind === "error" || event.kind === "started")).toBe(false);
    await adapter.dispose();
  });
});

describe("spotify-librespot capabilities", () => {
  it("reports unavailable when binary is missing", async () => {
    const a = new SpotifyLibrespotAdapter({ graph, binaryPath: "/nonexistent/librespot" });
    const caps = await a.capabilities();
    expect(caps.route).toBe("spotify-librespot");
    expect(caps.state).toBe("unavailable");
    expect(caps.playback.engine).toBe("none");
    expect(caps.notes.length).toBeGreaterThan(0);
  });

  it("reports unauthenticated when binary exists but no credentials", async () => {
    // A real executable file stands in for the librespot binary.
    const dir = mkdtempSync(join(tmpdir(), "cadence-lsp-"));
    const bin = join(dir, "librespot");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    try {
      const a = new SpotifyLibrespotAdapter({
        graph,
        binaryPath: bin,
        getCredentials: async () => null,
      });
      const caps = await a.capabilities();
      if (process.platform === "win32") {
        expect(caps.state).toBe("unavailable");
      } else {
        expect(caps.state).toBe("unauthenticated");
        expect(caps.audio.pcmAccess).toBe("yes");
        expect(caps.visuals.kind).toBe("pcm-fft");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
