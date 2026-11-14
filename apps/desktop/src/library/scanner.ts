import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { parseFile } from "music-metadata";
import type { TrackRecord } from "./library-db.js";

/** File extensions the local library indexes (lower-case, with dot). */
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  ".flac",
  ".wav",
  ".mp3",
  ".m4a",
  ".alac",
  ".aac",
  ".ogg",
  ".opus",
]);

/** The lyrics file that sits beside an audio file: same name, .lrc extension. */
export function sidecarLyricsPath(audioPath: string): string {
  return audioPath.slice(0, audioPath.length - extname(audioPath).length) + ".lrc";
}

/** Lyrics files larger than this are not lyrics. */
const MAX_LYRICS_BYTES = 1024 * 1024;

/** Read a lyrics file as text; null when it is missing, empty or too large. */
export async function readLyricsFile(path: string): Promise<string | null> {
  const st = await stat(path).catch(() => null);
  if (st === null || !st.isFile() || st.size > MAX_LYRICS_BYTES) return null;
  const text = await readFile(path, "utf-8").catch(() => null);
  if (text === null) return null;
  // Downloaded files often start with a byte-order mark.
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return clean.trim() === "" ? null : clean;
}

/** Stable track id: route prefix + content-independent path hash. */
export function trackIdForPath(path: string): string {
  return `local:${createHash("sha1").update(path).digest("hex").slice(0, 24)}`;
}

const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
};

/**
 * Filesystem + metadata side of indexing: recursive walks, music-metadata
 * parsing, embedded-artwork thumbnail extraction. Kept free of database and
 * Electron concerns so tests drive it directly.
 */
export class LibraryScanner {
  constructor(
    private readonly thumbnailDir: string,
    private readonly opts: {
      /** Downscale embedded art to a cache-friendly size; null keeps original. */
      resize?: (data: Uint8Array, format: string) => Promise<Uint8Array | null>;
    } = {},
  ) {}

  /** Recursively yield audio files under a file or directory path. */
  async *walkAudioFiles(root: string): AsyncGenerator<string> {
    const st = await stat(root).catch(() => null);
    if (st === null) return;
    if (st.isFile()) {
      if (AUDIO_EXTENSIONS.has(extname(root).toLowerCase())) yield root;
      return;
    }
    if (!st.isDirectory()) return;
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [] as const);
    for (const entry of entries) {
      const full = join(root, entry.name);
      if (entry.isDirectory()) {
        yield* this.walkAudioFiles(full);
      } else if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        yield full;
      }
    }
  }

  /**
   * Parse one audio file into a TrackRecord, extracting embedded artwork to
   * the thumbnail cache. Returns null when the file cannot be read at all.
   */
  async scanFile(path: string): Promise<TrackRecord | null> {
    const st = await stat(path).catch(() => null);
    if (st === null || !st.isFile()) return null;
    try {
      const meta = await parseFile(path, { duration: true, skipCovers: false });
      const { common, format } = meta;
      const artists = normalizeArtists(common.artists, common.artist, common.albumartist);
      const artworkPath = await this.cacheArtwork(path, common.picture?.[0]);
      const year = common.year ?? parseYear(common.date);
      const lyrics = await this.readLyrics(path, common as { lyrics?: unknown; unsynchronisedLyrics?: unknown });
      return {
        id: trackIdForPath(path),
        path,
        title: common.title ?? basename(path, extname(path)),
        artists,
        artistsText: artists.join("; "),
        primaryArtist: common.albumartist ?? artists[0] ?? "Unknown Artist",
        album: common.album ?? null,
        albumArtist: common.albumartist ?? null,
        durationMs: Math.round((format.duration ?? 0) * 1000),
        trackNumber: common.track.no,
        discNumber: common.disk.no,
        year,
        genre: common.genre ?? [],
        artworkPath,
        format: format.codec ?? format.container ?? extname(path).slice(1).toLowerCase(),
        sampleRateHz: format.sampleRate ?? null,
        bitDepth: format.bitsPerSample ?? null,
        channels: format.numberOfChannels ?? null,
        replayGainDb: common.replaygain_track_gain?.dB ?? null,
        mtimeMs: Math.round(st.mtimeMs),
        size: st.size,
        availability: "available",
        lyrics,
      };
    } catch {
      // Unparseable audio still gets indexed so the UI can show it honestly.
      return {
        id: trackIdForPath(path),
        path,
        title: basename(path, extname(path)),
        artists: [],
        artistsText: "",
        primaryArtist: "Unknown Artist",
        album: null,
        albumArtist: null,
        durationMs: 0,
        trackNumber: null,
        discNumber: null,
        lyrics: null,
        year: null,
        genre: [],
        artworkPath: null,
        format: extname(path).slice(1).toLowerCase(),
        sampleRateHz: null,
        bitDepth: null,
        channels: null,
        replayGainDb: null,
        mtimeMs: Math.round(st.mtimeMs),
        size: st.size,
        availability: "unavailable",
      };
    }
  }

  /** Lyrics: embedded tag first, then a same-name .lrc sidecar (which
   * wins — it's the format users edit and the only synced-lyrics channel). */
  private async readLyrics(
    path: string,
    common: { lyrics?: unknown; unsynchronisedLyrics?: unknown },
  ): Promise<string | null> {
    const embedded = (common.lyrics ?? common.unsynchronisedLyrics) as
      | Array<{ text?: string } | string>
      | undefined;
    let text: string | null = null;
    if (Array.isArray(embedded) && embedded.length > 0) {
      const first = embedded[0];
      text = typeof first === "string" ? first : first?.text ?? null;
    }
    return (await readLyricsFile(sidecarLyricsPath(path))) ?? text;
  }

  /** Write embedded artwork to the thumbnail cache; returns its path. */
  private async cacheArtwork(path: string, picture: { format: string; data: Uint8Array } | undefined): Promise<string | null> {
    if (picture === undefined || picture.data.byteLength === 0) return null;
    const hash = createHash("sha1").update(path).digest("hex");
    const resized = this.opts.resize
      ? await this.opts.resize(picture.data, picture.format).catch(() => null)
      : null;
    const ext = resized !== null ? ".png" : (MIME_EXT[picture.format] ?? ".img");
    const out = join(this.thumbnailDir, `${hash}${ext}`);
    try {
      await stat(out);
      return out; // already cached
    } catch {
      // not cached yet
    }
    await mkdir(this.thumbnailDir, { recursive: true });
    await writeFile(out, resized ?? picture.data).catch(() => undefined);
    return out;
  }
}

function normalizeArtists(artists: string[] | undefined, artist: string | undefined, albumartist: string | undefined): string[] {
  if (artists !== undefined && artists.length > 0) return artists;
  if (artist !== undefined && artist !== "") return [artist];
  if (albumartist !== undefined && albumartist !== "") return [albumartist];
  return [];
}

function parseYear(date: string | undefined): number | null {
  if (date === undefined) return null;
  const m = /^(\d{4})/.exec(date);
  return m === null ? null : parseInt(m[1] ?? "", 10);
}
