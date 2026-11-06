import type {
  ArtistRef,
  ArtworkRef,
  CatalogRequest,
  LibraryQuery,
  PlaybackCommand,
  ProviderId,
  QueueItem,
  QueueState,
  RouteId,
  TrackRef,
  TrackSource,
} from "@cadence/protocol";
import { err, isOk, ok, type Result } from "./result.js";

/**
 * Boundary parsers for inbound IPC payloads. Everything crossing from the
 * renderer is `unknown` until proven otherwise — these functions parse into
 * contract types or return a typed failure. Rejections never carry renderer
 * secrets; payloads are plain data.
 */

/** An IPC payload failed shape checks. */
export class InvalidIpcPayload extends Error {
  readonly _tag = "InvalidIpcPayload" as const;
  constructor(readonly detail: string) {
    super(`invalid IPC payload: ${detail}`);
  }
}

const ROUTE_IDS: ReadonlySet<string> = new Set([
  "local",
  "spotify-librespot",
  "spotify-web",
  "apple-musickit",
  "youtube-music",
]);

const PROVIDER_IDS: ReadonlySet<string> = new Set(["local", "spotify", "apple", "youtube"]);
const REPEAT_MODES: ReadonlySet<string> = new Set(["off", "all", "one"]);

function isObj(u: unknown): u is Record<string, unknown> {
  return typeof u === "object" && u !== null && !Array.isArray(u);
}

function fail(detail: string): Result<never, InvalidIpcPayload> {
  return err(new InvalidIpcPayload(detail));
}

/** Parse a route id string. */
export function parseRouteId(u: unknown): Result<RouteId, InvalidIpcPayload> {
  if (typeof u === "string" && ROUTE_IDS.has(u)) return ok(u as RouteId);
  return fail(`expected a route id, got ${JSON.stringify(u)}`);
}

/** Parse a list of filesystem paths (scan targets). */
export function parsePaths(u: unknown): Result<string[], InvalidIpcPayload> {
  if (!Array.isArray(u) || !u.every((p) => typeof p === "string")) {
    return fail("expected an array of path strings");
  }
  return ok(u);
}

/** Parse a {route, text} payload for provider catalog search. */
export function parseProviderSearch(
  u: unknown,
): Result<{ route: RouteId; text: string }, InvalidIpcPayload> {
  if (!isObj(u)) return fail("provider search expects {route, text}");
  const route = parseRouteId(u.route);
  if (!isOk(route)) return err(route.error);
  if (typeof u.text !== "string" || u.text.trim().length === 0) {
    return fail("provider search text must be a non-empty string");
  }
  if (u.text.length > 500) return fail("provider search text exceeds 500 chars");
  return ok({ route: route.value, text: u.text.trim() });
}

const PROVIDER_PLATFORMS: ReadonlySet<string> = new Set(["local", "spotify", "apple", "youtube"]);
const CATALOG_REQUEST_KINDS: ReadonlySet<string> = new Set([
  "search",
  "home",
  "browse",
  "radio",
  "album",
  "playlist",
  "artist",
  "library",
  "libraryDetail",
  "lyrics",
  "addToLibrary",
]);
const ENTRY_KINDS: ReadonlySet<string> = new Set(["song", "album", "playlist", "artist", "station"]);
const LIB_COLLECTIONS: ReadonlySet<string> = new Set(["songs", "albums", "artists", "playlists"]);

/** Parse a platform id for platform.get/set. */
export function parsePlatformId(u: unknown): Result<ProviderId, InvalidIpcPayload> {
  if (typeof u === "string" && PROVIDER_PLATFORMS.has(u)) return ok(u as ProviderId);
  return fail(`expected a platform id, got ${JSON.stringify(u)}`);
}

/** Common id + paging bounds shared by every catalog request kind. */
const MAX_ID_LEN = 256;
const MAX_LIMIT = 50;
const MAX_OFFSET = 10_000;

function checkPaging(u: { limit?: unknown; offset?: unknown }): InvalidIpcPayload | null {
  if (u.limit !== undefined && (typeof u.limit !== "number" || !Number.isInteger(u.limit) || u.limit < 1 || u.limit > MAX_LIMIT)) {
    return new InvalidIpcPayload(`catalog limit must be an integer in 1..${MAX_LIMIT}`);
  }
  if (u.offset !== undefined && (typeof u.offset !== "number" || !Number.isInteger(u.offset) || u.offset < 0 || u.offset > MAX_OFFSET)) {
    return new InvalidIpcPayload(`catalog offset must be an integer in 0..${MAX_OFFSET}`);
  }
  return null;
}

function checkId(u: unknown, what: string): InvalidIpcPayload | null {
  if (typeof u !== "string" || !u) return new InvalidIpcPayload(`${what} requires a non-empty id`);
  if (u.length > MAX_ID_LEN) return new InvalidIpcPayload(`${what} id exceeds ${MAX_ID_LEN} chars`);
  return null;
}

/** Parse {route, request} for catalog.query. */
export function parseCatalogQuery(
  u: unknown,
): Result<{ route: RouteId; request: CatalogRequest }, InvalidIpcPayload> {
  if (!isObj(u)) return fail("catalog query expects {route, request}");
  const route = parseRouteId(u.route);
  if (!isOk(route)) return err(route.error);
  const req = u.request;
  if (!isObj(req) || typeof req.kind !== "string" || !CATALOG_REQUEST_KINDS.has(req.kind)) {
    return fail(`catalog request must have a known kind, got ${JSON.stringify(isObj(req) ? req.kind : req)}`);
  }
  const pagingErr = checkPaging(req);
  if (pagingErr) return err(pagingErr);
  switch (req.kind) {
    case "search": {
      if (typeof req.text !== "string" || !req.text.trim()) {
        return fail("catalog search requires non-empty text");
      }
      if (req.text.length > 500) return fail("catalog search text exceeds 500 chars");
      if (req.types !== undefined && (!Array.isArray(req.types) || !req.types.every((t) => typeof t === "string" && ENTRY_KINDS.has(t)))) {
        return fail("catalog search types must be entry kinds");
      }
      break;
    }
    case "album":
    case "playlist":
    case "artist": {
      const e = checkId(req.id, `catalog ${req.kind}`);
      if (e) return err(e);
      break;
    }
    case "library": {
      if (typeof req.collection !== "string" || !LIB_COLLECTIONS.has(req.collection)) {
        return fail("catalog library requires collection in songs|albums|artists|playlists");
      }
      break;
    }
    case "libraryDetail": {
      if (req.collection !== "albums" && req.collection !== "playlists") {
        return fail("libraryDetail collection must be albums|playlists");
      }
      const e = checkId(req.id, "libraryDetail");
      if (e) return err(e);
      break;
    }
    case "lyrics": {
      const e = checkId(req.songId, "lyrics");
      if (e) return err(e);
      break;
    }
    case "addToLibrary": {
      if (!isObj(req.ids)) return fail("addToLibrary requires ids object");
      const keys = Object.keys(req.ids);
      if (keys.length > 32) return fail("addToLibrary supports at most 32 resource kinds");
      for (const k of keys) {
        if (!LIB_COLLECTIONS.has(k) && k !== "music-videos") {
          return fail(`addToLibrary key must be a library collection, got ${JSON.stringify(k)}`);
        }
        const v = (req.ids as Record<string, unknown>)[k];
        if (!Array.isArray(v) || v.length > 256 || !v.every((x) => typeof x === "string" && x.length > 0 && x.length <= MAX_ID_LEN)) {
          return fail(`addToLibrary.${k} must be an array of <=256 id strings`);
        }
      }
      break;
    }
  }
  return ok({ route: route.value, request: req as unknown as CatalogRequest });
}

/** Parse a track id for library.track. */
export function parseEqBands(
  u: unknown,
): Result<{ freqHz: number; gainDb: number }[], InvalidIpcPayload> {
  if (!Array.isArray(u) || u.length > 32) return fail(`eq bands: expected array of <=32`);
  for (const b of u) {
    if (
      typeof b !== "object" || b === null ||
      typeof (b as { freqHz?: unknown }).freqHz !== "number" ||
      typeof (b as { gainDb?: unknown }).gainDb !== "number" ||
      !Number.isFinite((b as { freqHz: number }).freqHz) ||
      !Number.isFinite((b as { gainDb: number }).gainDb)
    ) {
      return fail("eq band: expected {freqHz:number, gainDb:number}");
    }
  }
  return ok(u as { freqHz: number; gainDb: number }[]);
}

export function parseTrackId(u: unknown): Result<string, InvalidIpcPayload> {
  if (typeof u === "string" && u.length > 0) return ok(u);
  return fail("expected a non-empty track id");
}

/** Parse a LibraryQuery (all fields optional, type-checked). */
export function parseLibraryQuery(u: unknown): Result<LibraryQuery, InvalidIpcPayload> {
  if (u === undefined || u === null) return ok({});
  if (!isObj(u)) return fail("library query must be an object");
  const q: LibraryQuery = {};
  for (const key of ["text", "artist", "album", "genre"] as const) {
    const v = u[key];
    if (v !== undefined) {
      if (typeof v !== "string") return fail(`library query ${key} must be a string`);
      q[key] = v;
    }
  }
  for (const key of ["limit", "offset"] as const) {
    const v = u[key];
    if (v !== undefined) {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        return fail(`library query ${key} must be a non-negative number`);
      }
      q[key] = Math.floor(v);
    }
  }
  return ok(q);
}

// --- PlaybackCommand -----------------------------------------------------------

/** Parse a PlaybackCommand; all inbound commands pass through here. */
export function parsePlaybackCommand(u: unknown): Result<PlaybackCommand, InvalidIpcPayload> {
  if (!isObj(u) || typeof u.kind !== "string") return fail("command must be an object with a kind");
  switch (u.kind) {
    case "setQueue": {
      const items = parseQueueItemArray(u.items);
      if (!isOk(items)) return err(items.error);
      const cmd: Extract<PlaybackCommand, { kind: "setQueue" }> = { kind: "setQueue", items: items.value };
      if (u.startIndex !== undefined) {
        if (typeof u.startIndex !== "number" || !Number.isInteger(u.startIndex)) {
          return fail("setQueue.startIndex must be an integer");
        }
        cmd.startIndex = u.startIndex;
      }
      if (u.autoplay !== undefined) {
        if (typeof u.autoplay !== "boolean") return fail("setQueue.autoplay must be a boolean");
        cmd.autoplay = u.autoplay;
      }
      return ok(cmd);
    }
    case "insertNext":
    case "append": {
      const items = parseQueueItemArray(u.items);
      if (!isOk(items)) return err(items.error);
      return ok({ kind: u.kind, items: items.value });
    }
    case "remove": {
      if (!Array.isArray(u.queueIds) || !u.queueIds.every((id) => typeof id === "string")) {
        return fail("remove.queueIds must be an array of strings");
      }
      return ok({ kind: "remove", queueIds: u.queueIds });
    }
    case "move": {
      if (!Number.isInteger(u.fromIndex) || !Number.isInteger(u.toIndex)) {
        return fail("move requires integer fromIndex/toIndex");
      }
      return ok({ kind: "move", fromIndex: u.fromIndex as number, toIndex: u.toIndex as number });
    }
    case "play": {
      const cmd: Extract<PlaybackCommand, { kind: "play" }> = { kind: "play" };
      if (u.queueId !== undefined) {
        if (typeof u.queueId !== "string") return fail("play.queueId must be a string");
        cmd.queueId = u.queueId;
      }
      return ok(cmd);
    }
    case "pause":
    case "resume":
    case "stop":
    case "next":
    case "previous":
      return ok({ kind: u.kind });
    case "seek": {
      if (typeof u.positionMs !== "number" || !Number.isFinite(u.positionMs)) {
        return fail("seek.positionMs must be a finite number");
      }
      return ok({ kind: "seek", positionMs: u.positionMs });
    }
    case "setVolume": {
      if (typeof u.volume !== "number" || !Number.isFinite(u.volume)) {
        return fail("setVolume.volume must be a finite number");
      }
      return ok({ kind: "setVolume", volume: u.volume });
    }
    case "setMuted": {
      if (typeof u.muted !== "boolean") return fail("setMuted.muted must be a boolean");
      return ok({ kind: "setMuted", muted: u.muted });
    }
    case "setRepeat": {
      if (typeof u.repeat !== "string" || !REPEAT_MODES.has(u.repeat)) {
        return fail("setRepeat.repeat must be off|all|one");
      }
      return ok({ kind: "setRepeat", repeat: u.repeat as QueueState["repeat"] });
    }
    case "setShuffle": {
      if (typeof u.shuffle !== "boolean") return fail("setShuffle.shuffle must be a boolean");
      return ok({ kind: "setShuffle", shuffle: u.shuffle });
    }
    case "switchRoute": {
      const route = parseRouteId(u.route);
      if (!isOk(route)) return err(route.error);
      if (typeof u.queueId !== "string") return fail("switchRoute.queueId must be a string");
      return ok({ kind: "switchRoute", queueId: u.queueId, route: route.value });
    }
    case "setFidelityMode": {
      if (typeof u.enabled !== "boolean") return fail("setFidelityMode.enabled must be a boolean");
      return ok({ kind: "setFidelityMode", enabled: u.enabled });
    }
    default:
      return fail(`unknown command kind ${JSON.stringify(u.kind)}`);
  }
}

function isOk_<T>(r: Result<T, InvalidIpcPayload>): r is { _tag: "ok"; value: T } {
  return r._tag === "ok";
}

function parseQueueItemArray(u: unknown): Result<QueueItem[], InvalidIpcPayload> {
  if (!Array.isArray(u)) return fail("items must be an array");
  const items: QueueItem[] = [];
  for (const raw of u) {
    const item = parseQueueItem(raw);
    if (!isOk(item)) return err(item.error);
    items.push(item.value);
  }
  return ok(items);
}

function parseQueueItem(u: unknown): Result<QueueItem, InvalidIpcPayload> {
  if (!isObj(u)) return fail("queue item must be an object");
  const track = parseTrackRef(u.track);
  if (!isOk(track)) return err(track.error);
  const item: QueueItem = {
    queueId: typeof u.queueId === "string" ? u.queueId : "",
    track: track.value,
  };
  if (isObj(u.origin)) {
    const kind = u.origin.kind;
    if (kind === "album" || kind === "playlist" || kind === "manual" || kind === "provider") {
      const origin: NonNullable<QueueItem["origin"]> = { kind };
      if (typeof u.origin.id === "string") origin.id = u.origin.id;
      if (typeof u.origin.name === "string") origin.name = u.origin.name;
      item.origin = origin;
    }
  }
  return ok(item);
}

function parseTrackRef(u: unknown): Result<TrackRef, InvalidIpcPayload> {
  if (!isObj(u)) return fail("track must be an object");
  if (typeof u.id !== "string" || u.id === "") return fail("track.id must be a non-empty string");
  const route = parseRouteId(u.route);
  if (!isOk(route)) return err(route.error);
  if (typeof u.provider !== "string" || !PROVIDER_IDS.has(u.provider)) {
    return fail("track.provider must be a provider id");
  }
  if (typeof u.title !== "string") return fail("track.title must be a string");
  if (typeof u.durationMs !== "number" || !Number.isFinite(u.durationMs) || u.durationMs < 0) {
    return fail("track.durationMs must be a non-negative number");
  }
  const source = parseTrackSource(u.source);
  if (!isOk(source)) return err(source.error);
  const track: TrackRef = {
    id: u.id,
    route: route.value,
    provider: u.provider as ProviderId,
    title: u.title,
    artists: parseArtists(u.artists),
    durationMs: u.durationMs,
    source: source.value,
    availability:
      u.availability === "unavailable" || u.availability === "unknown" ? u.availability : "available",
  };
  if (typeof u.album === "string") track.album = u.album;
  if (typeof u.trackNumber === "number") track.trackNumber = u.trackNumber;
  if (typeof u.discNumber === "number") track.discNumber = u.discNumber;
  if (typeof u.year === "number") track.year = u.year;
  if (Array.isArray(u.genre)) track.genre = u.genre.filter((g): g is string => typeof g === "string");
  const artwork = parseArtwork(u.artwork);
  if (artwork !== null) track.artwork = artwork;
  if (typeof u.replayGainDb === "number" && Number.isFinite(u.replayGainDb)) {
    track.replayGainDb = u.replayGainDb;
  }
  if (typeof u.availabilityDetail === "string") track.availabilityDetail = u.availabilityDetail;
  return ok(track);
}

function parseArtists(u: unknown): ArtistRef[] {
  if (!Array.isArray(u)) return [];
  const out: ArtistRef[] = [];
  for (const a of u) {
    if (!isObj(a) || typeof a.name !== "string") continue;
    const ref: ArtistRef = { name: a.name };
    if (typeof a.providerId === "string") ref.providerId = a.providerId;
    out.push(ref);
  }
  return out;
}

function parseArtwork(u: unknown): ArtworkRef | null {
  if (!isObj(u) || typeof u.url !== "string") return null;
  const ref: ArtworkRef = { url: u.url };
  if (typeof u.width === "number") ref.width = u.width;
  if (typeof u.height === "number") ref.height = u.height;
  return ref;
}

function parseTrackSource(u: unknown): Result<TrackSource, InvalidIpcPayload> {
  if (!isObj(u)) return fail("track.source must be an object");
  if (u.kind === "file") {
    if (typeof u.path !== "string" || u.path === "") return fail("file source requires a path");
    const src: { kind: "file"; path: string; format?: string } = { kind: "file", path: u.path };
    if (typeof u.format === "string") src.format = u.format;
    return ok(src);
  }
  if (u.kind === "provider") {
    if (typeof u.providerItemId !== "string" || u.providerItemId === "") {
      return fail("provider source requires providerItemId");
    }
    const src: { kind: "provider"; providerItemId: string; uri?: string } = {
      kind: "provider",
      providerItemId: u.providerItemId,
    };
    if (typeof u.uri === "string") src.uri = u.uri;
    return ok(src);
  }
  return fail(`unknown source kind ${JSON.stringify(u.kind)}`);
}
