import { describe, expect, it } from "vitest";
import { normalizeHit, bestThumb } from "../src/adapters/providers/youtube-music-catalog.js";
import { SpotifyLibrespotAdapter, type LibrespotGraph } from "../src/adapters/providers/spotify-librespot.js";

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
    const a = new SpotifyLibrespotAdapter({
      graph,
      binaryPath: "librespot",
      getCredentials: async () => null,
    });
    const caps = await a.capabilities();
    if (process.platform === "win32") {
      expect(caps.state).toBe("unavailable");
    } else {
      expect(caps.state).toBe("unauthenticated");
      expect(caps.audio.pcmAccess).toBe("yes"); // binary resolvable via PATH
      expect(caps.visuals.kind).toBe("pcm-fft");
    }
  });
});
