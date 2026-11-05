import Database from "better-sqlite3";
import type {
  ArtworkRef,
  LibraryAlbum,
  LibraryQuery,
  TrackRef,
} from "@cadence/protocol";

/**
 * SQLite store for the local library: one `tracks` table plus an FTS5 index
 * over title/artists/album. better-sqlite3 is synchronous; scan work happens
 * in bounded batches from LibraryService so indexing never blocks the UI for
 * more than a few ms per batch.
 */

/** One row's worth of track data as the scanner produces it. */
export interface TrackRecord {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly artists: string[];
  readonly artistsText: string;
  readonly primaryArtist: string;
  readonly album: string | null;
  readonly albumArtist: string | null;
  readonly durationMs: number;
  readonly trackNumber: number | null;
  readonly discNumber: number | null;
  readonly year: number | null;
  readonly genre: string[];
  readonly artworkPath: string | null;
  readonly format: string | null;
  readonly sampleRateHz: number | null;
  readonly bitDepth: number | null;
  readonly channels: number | null;
  readonly replayGainDb: number | null;
  readonly mtimeMs: number;
  readonly size: number;
  readonly availability: "available" | "unavailable";
}

interface TrackRow {
  id: string;
  path: string;
  title: string;
  artists_json: string;
  artists_text: string;
  primary_artist: string;
  album: string | null;
  album_artist: string | null;
  duration_ms: number;
  track_number: number | null;
  disc_number: number | null;
  year: number | null;
  genre_json: string;
  artwork_path: string | null;
  format: string | null;
  sample_rate_hz: number | null;
  bit_depth: number | null;
  channels: number | null;
  replay_gain_db: number | null;
  mtime_ms: number;
  size: number;
  availability: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  artists_json TEXT NOT NULL,
  artists_text TEXT NOT NULL,
  primary_artist TEXT NOT NULL,
  album TEXT,
  album_artist TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  track_number INTEGER,
  disc_number INTEGER,
  year INTEGER,
  genre_json TEXT NOT NULL DEFAULT '[]',
  artwork_path TEXT,
  format TEXT,
  sample_rate_hz INTEGER,
  bit_depth INTEGER,
  channels INTEGER,
  replay_gain_db REAL,
  mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL,
  availability TEXT NOT NULL DEFAULT 'available'
);
CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(title, artists, album);
CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album, album_artist);
CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(primary_artist);
`;

/**
 * SQLite-backed library index. Pass ":memory:" in tests.
 */
export class LibraryDb {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  /** Close the database. */
  close(): void {
    this.db.close();
  }

  /** Insert or replace a track record and its FTS row (rowid = path hash). */
  upsertTrack(rec: TrackRecord): void {
    const upsert = this.db.prepare(`
      INSERT INTO tracks (id, path, title, artists_json, artists_text, primary_artist,
        album, album_artist, duration_ms, track_number, disc_number, year, genre_json,
        artwork_path, format, sample_rate_hz, bit_depth, channels, replay_gain_db,
        mtime_ms, size, availability)
      VALUES (@id, @path, @title, @artistsJson, @artistsText, @primaryArtist,
        @album, @albumArtist, @durationMs, @trackNumber, @discNumber, @year, @genreJson,
        @artworkPath, @format, @sampleRateHz, @bitDepth, @channels, @replayGainDb,
        @mtimeMs, @size, @availability)
      ON CONFLICT(path) DO UPDATE SET
        title=excluded.title, artists_json=excluded.artists_json,
        artists_text=excluded.artists_text, primary_artist=excluded.primary_artist,
        album=excluded.album, album_artist=excluded.album_artist,
        duration_ms=excluded.duration_ms, track_number=excluded.track_number,
        disc_number=excluded.disc_number, year=excluded.year, genre_json=excluded.genre_json,
        artwork_path=excluded.artwork_path, format=excluded.format,
        sample_rate_hz=excluded.sample_rate_hz, bit_depth=excluded.bit_depth,
        channels=excluded.channels, replay_gain_db=excluded.replay_gain_db,
        mtime_ms=excluded.mtime_ms, size=excluded.size, availability=excluded.availability
    `);
    const tx = this.db.transaction((r: TrackRecord) => {
      upsert.run({
        ...r,
        artistsJson: JSON.stringify(r.artists),
        genreJson: JSON.stringify(r.genre),
      });
      const row = this.db.prepare("SELECT rowid FROM tracks WHERE path = ?").get(r.path) as { rowid: number };
      this.db.prepare("DELETE FROM tracks_fts WHERE rowid = ?").run(row.rowid);
      this.db
        .prepare("INSERT INTO tracks_fts (rowid, title, artists, album) VALUES (?, ?, ?, ?)")
        .run(row.rowid, r.title, r.artistsText, r.album ?? "");
    });
    tx(rec);
  }

  /** Stored mtime+size for incremental re-scan decisions. */
  fileStamp(path: string): { mtimeMs: number; size: number } | null {
    const row = this.db
      .prepare("SELECT mtime_ms AS mtimeMs, size FROM tracks WHERE path = ?")
      .get(path) as { mtimeMs: number; size: number } | undefined;
    return row ?? null;
  }

  /** Remove a track by path (watch unlink, missing file on rescan). */
  deleteByPath(path: string): void {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare("SELECT rowid FROM tracks WHERE path = ?").get(path) as
        | { rowid: number }
        | undefined;
      if (row === undefined) return;
      this.db.prepare("DELETE FROM tracks_fts WHERE rowid = ?").run(row.rowid);
      this.db.prepare("DELETE FROM tracks WHERE rowid = ?").run(row.rowid);
    });
    tx();
  }

  /** All indexed file paths (for pruning removed files during rescan). */
  allPaths(): string[] {
    const rows = this.db.prepare("SELECT path FROM tracks").all() as { path: string }[];
    return rows.map((r) => r.path);
  }

  /** Query tracks; FTS5 text search plus exact-ish field filters. */
  tracks(q: LibraryQuery): TrackRef[] {
    const { where, params } = buildWhere(q);
    const sql = `SELECT * FROM tracks ${where} ORDER BY album, disc_number, track_number, title LIMIT @limit OFFSET @offset`;
    const rows = this.db.prepare(sql).all({ ...params, limit: q.limit ?? 500, offset: q.offset ?? 0 }) as TrackRow[];
    return rows.map(rowToTrackRef);
  }

  /** Albums, grouped by album + album artist. */
  albums(q: LibraryQuery): LibraryAlbum[] {
    const { where, params } = buildWhere(q);
    const sql = `
      SELECT album AS title,
             COALESCE(album_artist, primary_artist) AS artist,
             MIN(year) AS year,
             MAX(artwork_path) AS artworkPath,
             COUNT(*) AS trackCount
      FROM tracks ${where === "" ? "WHERE album IS NOT NULL" : `${where} AND album IS NOT NULL`}
      GROUP BY album, artist
      ORDER BY artist, year, album
      LIMIT @limit OFFSET @offset`;
    const rows = this.db.prepare(sql).all({ ...params, limit: q.limit ?? 500, offset: q.offset ?? 0 }) as {
      title: string;
      artist: string;
      year: number | null;
      artworkPath: string | null;
      trackCount: number;
    }[];
    return rows.map((r) => ({
      id: `album:${r.artist}::${r.title}`,
      title: r.title,
      artist: r.artist,
      ...(r.year !== null ? { year: r.year } : {}),
      ...(r.artworkPath !== null ? { artwork: fileArtwork(r.artworkPath) } : {}),
      trackCount: r.trackCount,
    }));
  }

  /** Artists with album/track counts. */
  artists(q: LibraryQuery): { name: string; albumCount: number; trackCount: number }[] {
    const { where, params } = buildWhere(q);
    const sql = `
      SELECT primary_artist AS name,
             COUNT(DISTINCT album) AS albumCount,
             COUNT(*) AS trackCount
      FROM tracks ${where}
      GROUP BY primary_artist
      ORDER BY primary_artist
      LIMIT @limit OFFSET @offset`;
    const rows = this.db.prepare(sql).all({ ...params, limit: q.limit ?? 500, offset: q.offset ?? 0 }) as {
      name: string;
      albumCount: number;
      trackCount: number;
    }[];
    return rows;
  }

  /** One track by id, or null. */
  track(id: string): TrackRef | null {
    const row = this.db.prepare("SELECT * FROM tracks WHERE id = ?").get(id) as TrackRow | undefined;
    return row === undefined ? null : rowToTrackRef(row);
  }
}

/** Build WHERE + named params for a LibraryQuery. */
function buildWhere(q: LibraryQuery): { where: string; params: Record<string, unknown> } {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  const text = q.text?.trim();
  if (text !== undefined && text !== "") {
    clauses.push("rowid IN (SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH @fts)");
    params.fts = ftsQuery(text);
  }
  if (q.artist !== undefined && q.artist !== "") {
    // Exact artist match within the "; "-delimited field — "Air" must not
    // match "Airbag". Pad the ends so first/last entries also match.
    // Exact match inside the "; "-joined artist list (normalize the space),
    // OR an album-artist match so compilations resolve to their owner.
    clauses.push(
      "(instr(';' || replace(artists_text, '; ', ';') || ';', ';' || @artist || ';') > 0" +
        " OR album_artist = @artist)",
    );
    params.artist = q.artist;
  }
  if (q.album !== undefined && q.album !== "") {
    clauses.push("album = @album");
    params.album = q.album;
  }
  if (q.genre !== undefined && q.genre !== "") {
    clauses.push("instr(genre_json, @genre) > 0");
    params.genre = q.genre;
  }
  return { where: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`, params };
}

/**
 * Build an FTS5 MATCH expression: whitespace-split tokens become prefix
 * terms ANDed together, searched across all indexed columns.
 */
export function ftsQuery(text: string): string {
  const terms = text
    .split(/\s+/)
    .filter((t) => t !== "")
    .map((t) => `"${t.replace(/"/g, '""')}"*`);
  return terms.length === 0 ? '""' : terms.join(" AND ");
}

function fileArtwork(path: string): ArtworkRef {
  // Served by the cadence-art:// protocol handler registered in main.ts —
  // works from any renderer origin (file:// bundle or http dev server)
  // without exposing arbitrary file:// reads.
  return { url: `cadence-art://artwork/${encodeURIComponent(path)}` };
}

function rowToTrackRef(row: TrackRow): TrackRef {
  const artists = JSON.parse(row.artists_json) as string[];
  const genre = JSON.parse(row.genre_json) as string[];
  return {
    id: row.id,
    route: "local",
    provider: "local",
    title: row.title,
    artists: artists.map((name) => ({ name })),
    ...(row.album !== null ? { album: row.album } : {}),
    durationMs: row.duration_ms,
    ...(row.track_number !== null ? { trackNumber: row.track_number } : {}),
    ...(row.disc_number !== null ? { discNumber: row.disc_number } : {}),
    ...(row.year !== null ? { year: row.year } : {}),
    ...(genre.length > 0 ? { genre } : {}),
    ...(row.artwork_path !== null ? { artwork: fileArtwork(row.artwork_path) } : {}),
    source: {
      kind: "file",
      path: row.path,
      ...(row.format !== null ? { format: row.format } : {}),
    },
    ...(row.replay_gain_db !== null ? { replayGainDb: row.replay_gain_db } : {}),
    availability: row.availability === "unavailable" ? "unavailable" : "available",
  };
}
