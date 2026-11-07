import { describe, expect, it } from "vitest";
import {
  AppleMusicCatalog,
  resourceToEntry,
  songToTrack,
  ttmlToLrc,
  type AmpCall,
} from "../src/adapters/providers/apple-music-catalog.js";

const catalogSong = {
  id: "1638456789",
  type: "songs",
  attributes: {
    name: "Get Lucky",
    artistName: "Daft Punk",
    albumName: "Random Access Memories",
    durationInMillis: 369629,
    trackNumber: 5,
    genreNames: ["Electronic"],
    releaseDate: "2013-05-17",
    artwork: { url: "https://is1.example/{w}x{h}bb.jpg", width: 3000, height: 3000 },
    playParams: { id: "1638456789", kind: "song" },
  },
};

const librarySong = {
  id: "i.dlvqVzpfzp9qmoW",
  type: "library-songs",
  attributes: {
    name: "Dark Beach",
    artistName: "Billx",
    albumName: "Abyss",
    durationInMillis: 222000,
    playParams: {
      id: "i.dlvqVzpfzp9qmoW",
      catalogId: "1765232514",
      isLibrary: true,
      kind: "song",
    },
  },
};

describe("songToTrack", () => {
  it("converts a catalog song", () => {
    const t = songToTrack(catalogSong);
    expect(t.id).toBe("apple-musickit:1638456789");
    expect(t.title).toBe("Get Lucky");
    expect(t.artists[0]?.name).toBe("Daft Punk");
    expect(t.album).toBe("Random Access Memories");
    expect(t.durationMs).toBe(369629);
    expect(t.source.kind === "provider" ? t.source.uri : null).toBe("am:song:1638456789");
    expect(t.source.kind === "provider" ? t.source.providerItemId : null).toBe("1638456789");
    expect(t.availability).toBe("available");
    expect(t.artwork?.url).toBe("https://is1.example/600x600bb.jpg");
  });

  it("keeps library ids for library songs", () => {
    const t = songToTrack(librarySong);
    expect(t.source.kind === "provider" ? t.source.uri : null).toBe("am:library-song:i.dlvqVzpfzp9qmoW");
    expect(t.source.kind === "provider" ? t.source.providerItemId : null).toBe("i.dlvqVzpfzp9qmoW");
  });
});

describe("ttmlToLrc", () => {
  it("maps TTML lines to LRC stamps", () => {
    const ttml = `<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div>
      <p begin="00:01.5" end="00:04.0">Signal on the wire</p>
      <p begin="01:10.000" end="01:12.000"><span>Words</span> inside</p>
    </div></body></tt>`;
    const lrc = ttmlToLrc(ttml);
    expect(lrc).toContain("[00:01.50]Signal on the wire");
    expect(lrc).toContain("[01:10.00]Words inside");
  });
});

describe("resourceToEntry", () => {
  it("marks library containers", () => {
    const e = resourceToEntry(
      {
        id: "p.MoGJ",
        type: "library-playlists",
        attributes: { name: "BALLIN", playParams: { id: "p.MoGJ", isLibrary: true } },
      },
    );
    expect(e?.kind).toBe("playlist");
    if (e?.kind === "playlist") {
      expect(e.playlist.isLibraryItem).toBe(true);
      expect(e.playlist.title).toBe("BALLIN");
    }
  });

  it("converts stations", () => {
    const e = resourceToEntry(
      {
        id: "ra.978194965",
        type: "stations",
        attributes: { name: "Apple Music 1", editorialNotes: { short: "Live" } },
      },
    );
    expect(e?.kind).toBe("station");
    if (e?.kind === "station") {
      expect(e.station.id).toBe("ra.978194965");
      expect(e.station.name).toBe("Apple Music 1");
    }
  });
});

describe("AppleMusicCatalog", () => {
  function makeCatalog(responses: Record<string, unknown>) {
    const calls: { path: string; params?: unknown }[] = [];
    const amp: AmpCall = async (path, params) => {
      calls.push({ path, params });
      const keys = Object.keys(responses).sort((a, b) => b.length - a.length);
      for (const key of keys) {
        if (path.startsWith(key)) return responses[key];
      }
      return { data: [] };
    };
    return { catalog: new AppleMusicCatalog({ amp, storefront: async () => "us" }), calls };
  }

  it("maps search results to sections", async () => {
    const { catalog } = makeCatalog({
      "/v1/catalog/us/search": {
        results: {
          songs: { data: [catalogSong] },
          albums: {
            data: [
              {
                id: "1440880481",
                type: "albums",
                attributes: {
                  name: "Random Access Memories",
                  artistName: "Daft Punk",
                  releaseDate: "2013-05-17",
                  playParams: { id: "1440880481", kind: "album" },
                },
              },
            ],
          },
        },
      },
    });
    const page = await catalog.query({ kind: "search", text: "get lucky" });
    const kinds = page.sections.map((s) => s.entries[0]?.kind);
    expect(kinds).toContain("song");
    expect(kinds).toContain("album");
    const songs = page.sections.find((s) => s.id === "search-songs");
    expect(songs?.entries[0]?.kind === "song" && songs.entries[0].track.durationMs).toBe(369629);
  });

  it("fetches library playlist tracks via the /tracks sub-endpoint", async () => {
    const { catalog, calls } = makeCatalog({
      "/v1/me/library/playlists/p.x": {
        data: [
          {
            id: "p.x",
            type: "library-playlists",
            attributes: { name: "BALLIN" },
            // no relationships.tracks — must hit /tracks
          },
        ],
      },
      "/v1/me/library/playlists/p.x/tracks": { data: [librarySong, librarySong] },
    });
    const page = await catalog.query({ kind: "libraryDetail", collection: "playlists", id: "p.x" });
    expect(calls.some((c) => c.path === "/v1/me/library/playlists/p.x/tracks")).toBe(true);
    expect(page.title).toBe("BALLIN");
    expect(page.sections[0]?.entries).toHaveLength(2);
  });

  it("groups library albums+songs under headings", async () => {
    const { catalog } = makeCatalog({
      "/v1/me/library/albums": {
        data: [
          { id: "l.a1", type: "library-albums", attributes: { name: "Abyss", artistName: "Billx" } },
        ],
      },
      "/v1/me/library/songs": { data: [librarySong] },
    });
    const page = await catalog.query({ kind: "library", collection: "albums", limit: 10 });
    const albums = page.sections.flatMap((s) => s.entries).filter((e) => e.kind === "album");
    expect(albums.length).toBe(1);
    const songs = await catalog.query({ kind: "library", collection: "songs", limit: 10 });
    expect(songs.sections[0]?.entries[0]?.kind).toBe("song");
  });
});
