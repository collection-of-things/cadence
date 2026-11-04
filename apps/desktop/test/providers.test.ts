import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TrackRef } from "@cadence/protocol";
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

describe("youtube-music search", () => {
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
