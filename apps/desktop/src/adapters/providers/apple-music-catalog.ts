/**
 * Apple Music catalog layer — pure functions, no Electron imports.
 *
 * Maps Cadence CatalogRequests onto amp-api.music.apple.com paths and
 * normalizes Apple Music API resources into protocol types. The adapter
 * supplies `amp(path, params, method?)` which executes inside the
 * music.apple.com page (MusicKit's own developer token + user token).
 */

import type {
  CatalogEntry,
  CatalogPage,
  CatalogRequest,
  CatalogSection,
  CatalogContainer,
  TrackRef,
} from "@cadence/protocol";

export class CatalogError extends Error {
  constructor(
    message: string,
    readonly retriable: boolean,
    readonly needsAuth = false,
  ) {
    super(message);
  }
}

/** Executes a MusicKit api call inside the provider page. */
export type AmpCall = (
  path: string,
  params?: Record<string, string | number>,
  method?: "get" | "post" | "delete",
) => Promise<unknown>;

// --- resource normalization -------------------------------------------------

interface AmArtwork {
  url?: string;
  bgColor?: string;
  height?: number;
  width?: number;
}

interface AmPlayParams {
  id?: string;
  kind?: string;
  catalogId?: string;
  isLibrary?: boolean;
}

interface AmAttributes {
  name?: string;
  artistName?: string;
  albumArtistName?: string;
  albumName?: string;
  curatorName?: string;
  durationInMillis?: number;
  trackNumber?: number;
  discNumber?: number;
  trackCount?: number;
  releaseDate?: string;
  genreNames?: string[];
  artwork?: AmArtwork;
  playParams?: AmPlayParams;
  contentRating?: string;
  url?: string;
  editorialNotes?: { short?: string; standard?: string };
  title?: { stringForDisplay?: string };
  reason?: { stringForDisplay?: string };
  description?: { standard?: string; short?: string };
  isLive?: boolean;
}

interface AmResource {
  id: string;
  type: string;
  href?: string;
  attributes?: AmAttributes;
  relationships?: {
    tracks?: { data?: AmResource[]; next?: string };
    contents?: { data?: AmResource[] };
    artists?: { data?: AmResource[] };
    catalog?: { data?: AmResource[] };
  };
}

const ROUTE = "apple-musickit" as const;

function artwork(aw: AmArtwork | undefined, size = 600) {
  if (!aw?.url) return undefined;
  const url = aw.url.replace("{w}", String(size)).replace("{h}", String(size));
  return { url, width: size, height: size };
}

function yearOf(releaseDate?: string): number | undefined {
  const y = releaseDate ? parseInt(releaseDate.slice(0, 4), 10) : NaN;
  return Number.isFinite(y) ? y : undefined;
}

function baseType(type: string): string {
  return type.replace(/^library-/, "");
}

function isLibraryResource(r: AmResource): boolean {
  return r.type.startsWith("library-") || r.attributes?.playParams?.isLibrary === true;
}

/** An Apple song resource -> a Cadence TrackRef. */
export function songToTrack(r: AmResource): TrackRef {
  const a = r.attributes ?? {};
  const pp = a.playParams;
  const library = isLibraryResource(r);
  const catalogId = pp?.catalogId;
  const playId = catalogId ?? pp?.id ?? r.id;
  const source = library
    ? {
        kind: "provider" as const,
        providerItemId: pp?.id ?? r.id,
        uri: `am:library-song:${pp?.id ?? r.id}`,
        // The catalog twin — lyrics and catalog lookups key off this id.
        ...(catalogId ? { catalogId } : {}),
      }
    : { kind: "provider" as const, providerItemId: playId, uri: `am:song:${playId}` };
  const artistId = r.relationships?.artists?.data?.[0]?.id;
  const track: TrackRef = {
    id: `${ROUTE}:${r.id}`,
    route: ROUTE,
    provider: "apple",
    title: a.name ?? "Unknown title",
    artists: [
      {
        name: a.artistName ?? "Unknown artist",
        ...(artistId ? { providerId: artistId } : {}),
      },
    ],
    durationMs: a.durationInMillis ?? 0,
    source,
    availability: pp !== undefined ? "available" : "unknown",
    ...(pp === undefined ? { availabilityDetail: "No play parameters returned" } : {}),
  };
  if (a.albumName) track.album = a.albumName;
  if (typeof a.trackNumber === "number") track.trackNumber = a.trackNumber;
  if (typeof a.discNumber === "number") track.discNumber = a.discNumber;
  const year = yearOf(a.releaseDate);
  if (year !== undefined) track.year = year;
  if (a.genreNames?.length) track.genre = a.genreNames;
  const aw = artwork(a.artwork);
  if (aw) track.artwork = aw;
  return track;
}

function containerFor(r: AmResource): CatalogContainer {
  const a = r.attributes ?? {};
  const kind = baseType(r.type) === "playlists" ? "playlist" : "album";
  const c: CatalogContainer = {
    kind,
    id: r.id,
    route: ROUTE,
    provider: "apple",
    title: a.name ?? (kind === "playlist" ? "Untitled playlist" : "Untitled album"),
    ...(isLibraryResource(r) ? { isLibraryItem: true } : {}),
  };
  const sub = a.artistName ?? a.curatorName;
  if (sub) c.subtitle = sub;
  const aw = artwork(a.artwork);
  if (aw) c.artwork = aw;
  if (typeof a.trackCount === "number") c.itemCount = a.trackCount;
  const year = yearOf(a.releaseDate);
  if (year !== undefined) c.year = year;
  return c;
}

/** Any Apple resource -> a section entry (null when unrepresentable). */
export function resourceToEntry(r: AmResource): CatalogEntry | null {
  const t = baseType(r.type);
  if (t === "songs" || t === "music-videos") return { kind: "song", track: songToTrack(r) };
  if (t === "albums") return { kind: "album", album: containerFor(r) };
  if (t === "playlists") return { kind: "playlist", playlist: containerFor(r) };
  if (t === "artists") {
    const a = r.attributes ?? {};
    const aw = artwork(a.artwork);
    return {
      kind: "artist",
      artist: {
        kind: "artist",
        id: r.id,
        route: ROUTE,
        provider: "apple",
        name: a.name ?? "Unknown artist",
        ...(aw ? { artwork: aw } : {}),
      },
    };
  }
  if (t === "stations") {
    const a = r.attributes ?? {};
    const aw = artwork(a.artwork);
    return {
      kind: "station",
      station: {
        kind: "station",
        id: r.id,
        route: ROUTE,
        provider: "apple",
        name: a.name ?? "Radio",
        ...(a.editorialNotes?.short ? { subtitle: a.editorialNotes.short } : {}),
        ...(aw ? { artwork: aw } : {}),
      },
    };
  }
  return null;
}

function entriesOf(list: AmResource[] | undefined): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const r of list ?? []) {
    const e = resourceToEntry(r);
    if (e) out.push(e);
  }
  return out;
}

/** A station entry -> a playable pseudo-track (stations stream endlessly). */
export function stationTrackRef(station: {
  id: string;
  name: string;
  subtitle?: string;
  artwork?: { url: string; width?: number; height?: number };
}): TrackRef {
  return {
    id: `${ROUTE}:station:${station.id}`,
    route: ROUTE,
    provider: "apple",
    title: station.name,
    artists: [{ name: "Apple Music Radio" }],
    durationMs: 0,
    ...(station.artwork ? { artwork: station.artwork } : {}),
    source: { kind: "provider", providerItemId: station.id, uri: `am:station:${station.id}` },
    availability: "available",
  };
}

// --- TTML -> LRC ---------------------------------------------------------------

const LRC_TIME = /(?:\d+:)?(\d+):(\d+(?:\.\d+)?)/;

function ttmlTimeToSeconds(v: string): number | null {
  const m = v.trim().match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$|^(\d+(?:\.\d+)?)s$/);
  if (!m) return null;
  if (m[4] !== undefined) return parseFloat(m[4]);
  const h = m[1] ? parseInt(m[1], 10) : 0;
  return h * 3600 + parseInt(m[2] ?? "0", 10) * 60 + parseFloat(m[3] ?? "0");
}

function lrcStamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `[${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}]`;
}

/** Convert Apple TTML lyrics to LRC. Falls back to plain lines without times. */
export function ttmlToLrc(ttml: string): string {
  const lines: { at: number | null; text: string }[] = [];
  const para = /<p[^>]*>/gi;
  const close = "</p>";
  let idx = 0;
  while (idx < ttml.length) {
    const open = ttml.indexOf("<p", idx);
    if (open < 0) break;
    const tagEnd = ttml.indexOf(">", open);
    const end = ttml.indexOf(close, tagEnd);
    if (tagEnd < 0 || end < 0) break;
    const tag = ttml.slice(open, tagEnd + 1);
    const body = ttml
      .slice(tagEnd + 1, end)
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .trim();
    const beginMatch = tag.match(/begin="([^"]+)"/);
    const at = beginMatch ? ttmlTimeToSeconds(beginMatch[1] ?? "") : null;
    if (body) lines.push({ at, text: body });
    idx = end + close.length;
  }
  if (lines.length === 0) return "";
  if (lines.every((l) => l.at === null)) {
    return lines.map((l) => l.text).join("\n");
  }
  return lines
    .map((l) => (l.at === null ? l.text : `${lrcStamp(l.at)}${l.text}`))
    .join("\n");
}

// --- request plumbing ---------------------------------------------------------

export interface AppleCatalogDeps {
  amp: AmpCall;
  storefront(): Promise<string>;
}

interface PagedBlock {
  data?: AmResource[];
  next?: string;
  href?: string;
}

function offsetFromNext(next: unknown): number | undefined {
  if (typeof next !== "string") return undefined;
  const m = next.match(/offset=(\d+)/);
  return m ? parseInt(m[1] ?? "0", 10) : undefined;
}

const TYPE_PARAM: Record<string, string> = {
  song: "songs",
  album: "albums",
  playlist: "playlists",
  artist: "artists",
  station: "stations",
};

export class AppleMusicCatalog {
  constructor(private deps: AppleCatalogDeps) {}

  async query(req: CatalogRequest): Promise<CatalogPage> {
    switch (req.kind) {
      case "search":
        return this.search(req);
      case "home":
        return this.home();
      case "browse":
        return this.browse();
      case "radio":
        return this.radio();
      case "album":
        return this.detail("albums", req.id, false);
      case "playlist":
        return this.detail("playlists", req.id, false);
      case "artist":
        return this.artist(req.id);
      case "library":
        return this.library(req);
      case "libraryDetail":
        return this.detail(req.collection, req.id, true);
      case "lyrics":
        return this.lyrics(req.songId);
      case "addToLibrary":
        return this.addToLibrary(req.ids);
    }
  }

  private async sf(): Promise<string> {
    return (await this.deps.storefront()) || "us";
  }

  private async amp(path: string, params?: Record<string, string | number>, method?: "get" | "post" | "delete") {
    try {
      return await this.deps.amp(path, params, method);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const needsAuth = /\b401\b|\b403\b|unauthor/i.test(message);
      throw new CatalogError(`Apple Music API: ${message}`, true, needsAuth);
    }
  }

  private async search(req: Extract<CatalogRequest, { kind: "search" }>): Promise<CatalogPage> {
    const sf = await this.sf();
    const types = (req.types ?? ["song", "album", "playlist", "artist", "station"])
      .map((t) => TYPE_PARAM[t])
      .filter(Boolean)
      .join(",");
    const params: Record<string, string | number> = {
      term: req.text,
      types,
      limit: req.limit ?? 10,
    };
    if (req.offset) params.offset = req.offset;
    const res = (await this.amp(`/v1/catalog/${sf}/search`, params)) as {
      results?: Record<string, PagedBlock>;
    };
    const titles: Record<string, string> = {
      songs: "Songs",
      albums: "Albums",
      playlists: "Playlists",
      artists: "Artists",
      stations: "Radio stations",
      "music-videos": "Music videos",
    };
    const sections: CatalogSection[] = [];
    let nextOffset: number | undefined;
    for (const [key, block] of Object.entries(res.results ?? {})) {
      const entries = entriesOf(block.data);
      if (!entries.length) continue;
      sections.push({ id: `search-${key}`, title: titles[key] ?? key, entries });
      const n = offsetFromNext(block.next);
      if (n !== undefined) nextOffset = n;
    }
    return { title: `Search: ${req.text}`, sections, ...(nextOffset !== undefined ? { nextOffset } : {}) };
  }

  private async home(): Promise<CatalogPage> {
    // Listen Now — personalized recommendations (requires auth).
    let sections: CatalogSection[] = [];
    try {
      const res = (await this.amp("/v1/me/recommendations")) as { data?: AmResource[] };
      for (const rec of res.data ?? []) {
        const a = rec.attributes ?? {};
        const title = a.title?.stringForDisplay ?? "For You";
        const entries = entriesOf(rec.relationships?.contents?.data);
        if (entries.length) {
          sections.push({
            id: rec.id,
            title,
            ...(a.reason?.stringForDisplay ? { subtitle: a.reason.stringForDisplay } : {}),
            entries,
          });
        }
      }
    } catch {
      // Personalized sections are best-effort — a transient failure or
      // missing auth must not sink the whole page.
    }
    // Recently played — also needs auth, but degrade silently.
    try {
      const recent = (await this.amp("/v1/me/recent/played", { limit: "20" })) as {
        data?: AmResource[];
      };
      const entries = entriesOf(recent.data);
      if (entries.length) {
        sections.push({ id: "recently-played", title: "Recently Played", entries });
      }
    } catch {
      /* degrade */
    }
    if (sections.length === 0) return this.browse("Listen Now");
    return { title: "Listen Now", sections };
  }

  private async browse(title = "Browse"): Promise<CatalogPage> {
    const sf = await this.sf();
    // The web app's own browse data comes from the editorial groupings feed.
    try {
      const res = (await this.amp(`/v1/editorial/${sf}/groupings`, {
        platform: "web",
        name: "browse",
        limit: "30",
      })) as { data?: Record<string, { children?: AmResource[] } | AmResource[] > };
      const sections = sectionsFromGroupings(res.data);
      if (sections.length) return { title, sections };
    } catch {
      /* fall through to charts */
    }
    const res = (await this.amp(`/v1/catalog/${sf}/charts`, {
      types: "songs,albums,playlists",
      limit: "20",
    })) as { results?: Record<string, { chart?: string; name?: string; data?: AmResource[] }[]> };
    const sections: CatalogSection[] = [];
    for (const [key, blocks] of Object.entries(res.results ?? {})) {
      for (const block of blocks ?? []) {
        const entries = entriesOf(block.data);
        if (!entries.length) continue;
        sections.push({ id: `chart-${key}-${block.chart ?? sections.length}`, title: block.name ?? `Top ${key}`, entries });
      }
    }
    return { title, sections };
  }

  private async radio(): Promise<CatalogPage> {
    const sections: CatalogSection[] = [];
    // Recently played stations (personal) first.
    try {
      const recent = (await this.amp("/v1/me/recent/played", { limit: "25" })) as {
        data?: AmResource[];
      };
      const stations = entriesOf((recent.data ?? []).filter((r) => baseType(r.type) === "stations"));
      if (stations.length) {
        sections.push({ id: "recent-stations", title: "Recently Played", entries: stations });
      }
    } catch {
      /* unauthenticated — drop silently */
    }
    // Featured stations via editorial groupings (name=radio), else search.
    const sf = await this.sf();
    let featured: CatalogEntry[] = [];
    try {
      const res = (await this.amp(`/v1/editorial/${sf}/groupings`, {
        platform: "web",
        name: "radio",
        limit: "30",
      })) as { data?: Record<string, { children?: AmResource[] } | AmResource[]> };
      const grouped = sectionsFromGroupings(res.data);
      for (const s of grouped) {
        const st = s.entries.filter((e) => e.kind === "station");
        if (st.length) featured.push(...st);
      }
    } catch {
      /* fall through */
    }
    if (featured.length === 0) {
      try {
        const res = (await this.amp(`/v1/catalog/${sf}/search`, {
          term: "apple music",
          types: "stations",
          limit: "20",
        })) as { results?: Record<string, PagedBlock> };
        featured = entriesOf(res.results?.stations?.data);
      } catch {
        /* leave empty */
      }
    }
    if (featured.length) sections.push({ id: "stations", title: "Stations", entries: featured });
    return { title: "Radio", sections };
  }

  private async detail(collection: "albums" | "playlists", id: string, library: boolean): Promise<CatalogPage> {
    const sf = await this.sf();
    const path = library
      ? `/v1/me/library/${collection}/${encodeURIComponent(id)}`
      : `/v1/catalog/${sf}/${collection}/${encodeURIComponent(id)}`;
    const res = (await this.amp(path)) as { data?: AmResource[] };
    const r = res.data?.[0];
    if (!r) throw new CatalogError(`${collection.slice(0, -1)} ${id} not found`, false);
    const a = r.attributes ?? {};
    // Library playlist details don't embed tracks — they live on /tracks.
    // Albums (catalog or library) do embed them in relationships.tracks.
    // Either way the track list can paginate; follow `next` up to a cap.
    let trackResources: AmResource[] = [];
    const MAX_TRACKS = 500;
    let next: string | undefined;
    const take = (block: { data?: AmResource[]; next?: string }) => {
      trackResources.push(...(block.data ?? []));
      next = block.next;
    };
    let trackRel = r.relationships?.tracks;
    if (library && collection === "playlists" && !trackRel?.data?.length) {
      const t = (await this.amp(`${path}/tracks`, { limit: "100" })) as {
        data?: AmResource[];
        next?: string;
      };
      take(t);
    } else {
      trackResources = trackRel?.data ?? [];
      next = trackRel?.next;
    }
    while (next && trackResources.length < MAX_TRACKS) {
      // `next` is a relative API href like "/v1/catalog/us/albums/123/tracks?offset=..."
      const page = (await this.amp(next)) as { data?: AmResource[]; next?: string };
      take(page);
    }
    if (next) {
      // Pages beyond the cap are dropped honestly in the UI (partial list).
      trackResources = trackResources.slice(0, MAX_TRACKS);
    }
    const tracks = entriesOf(trackResources).filter(
      (e): e is Extract<CatalogEntry, { kind: "song" }> => e.kind === "song",
    );
    const aw = artwork(a.artwork);
    const page: CatalogPage = {
      title: a.name ?? "Untitled",
      ...(a.artistName ?? a.curatorName ? { subtitle: a.artistName ?? a.curatorName } : {}),
      ...(aw ? { artwork: aw } : {}),
      sections: [{ id: "tracks", title: "Tracks", entries: tracks }],
    };
    if (a.description?.standard ?? a.editorialNotes?.standard) {
      page.sections.push({
        id: "about",
        title: "About",
        entries: [],
      });
    }
    return page;
  }

  private async artist(id: string): Promise<CatalogPage> {
    const sf = await this.sf();
    const res = (await this.amp(`/v1/catalog/${sf}/artists/${encodeURIComponent(id)}`)) as { data?: AmResource[] };
    const a = res.data?.[0]?.attributes ?? {};
    const aw = artwork(a.artwork);
    const page: CatalogPage = {
      title: a.name ?? "Artist",
      ...(aw ? { artwork: aw } : {}),
      sections: [],
    };
    const views: [string, string][] = [
      ["top-songs", "Top Songs"],
      ["top-albums", "Top Albums"],
      ["latest-release", "Latest Release"],
      ["top-playlists", "Playlists"],
      ["similar-artists", "Similar Artists"],
    ];
    // Five view calls in parallel — the IPC bound is 20s total.
    const fetched = await Promise.all(
      views.map(async ([view, title]) => {
        try {
          const v = (await this.amp(`/v1/catalog/${sf}/artists/${id}/view/${view}`, { limit: "10" })) as {
            data?: AmResource[];
          };
          const entries = entriesOf(v.data);
          return entries.length ? { view, title, entries } : null;
        } catch {
          return null; // a missing view just drops
        }
      }),
    );
    for (const v of fetched) {
      if (v) sections_push(page, `artist-${v.view}`, v.title, v.entries);
    }
    return page;
  }

  private async library(req: Extract<CatalogRequest, { kind: "library" }>): Promise<CatalogPage> {
    const params: Record<string, string | number> = {
      limit: req.limit ?? 25,
      offset: req.offset ?? 0,
    };
    // Include catalog metadata for richer display where Apple supports it.
    if (req.collection === "albums" || req.collection === "songs") {
      params["include[library-albums]"] = "catalog";
      params["include[library-songs]"] = "catalog";
    }
    const res = (await this.amp(`/v1/me/library/${req.collection}`, params)) as PagedBlock;
    const entries = entriesOf(res.data);
    const titles = { songs: "Songs", albums: "Albums", artists: "Artists", playlists: "Playlists" };
    const nextOffset = offsetFromNext(res.next);
    return {
      title: `Library — ${titles[req.collection]}`,
      sections: [{ id: `library-${req.collection}`, title: titles[req.collection], entries }],
      ...(nextOffset !== undefined ? { nextOffset } : {}),
    };
  }

  private async lyrics(songId: string): Promise<CatalogPage> {
    const sf = await this.sf();
    const res = (await this.amp(`/v1/catalog/${sf}/songs/${encodeURIComponent(songId)}/lyrics`)) as {
      data?: { attributes?: { ttml?: string } }[];
    };
    const ttml = res.data?.[0]?.attributes?.ttml;
    if (!ttml) return { sections: [] };
    return { sections: [], lyrics: ttmlToLrc(ttml) };
  }

  private async addToLibrary(
    ids: Partial<Record<"songs" | "albums" | "playlists" | "music-videos", string[]>>,
  ): Promise<CatalogPage> {
    const params: Record<string, string> = {};
    for (const [kind, list] of Object.entries(ids)) {
      if (list?.length) params[`ids[${kind}]`] = list.join(",");
    }
    if (Object.keys(params).length === 0) return { sections: [] };
    await this.amp("/v1/me/library", params, "post");
    return { sections: [] };
  }
}

function sections_push(page: CatalogPage, id: string, title: string, entries: CatalogEntry[]): void {
  page.sections.push({ id, title, entries });
}

/**
 * The editorial groupings feed nests real resources under
 * `relationships.tabs.data[].relationships.children.data[].relationships.contents.data`
 * (editorial-elements wrapping editorial-elements). Walk the structure and
 * emit a section wherever a node holds contents.
 */
function sectionsFromGroupings(data: unknown): CatalogSection[] {
  const sections: CatalogSection[] = [];
  const walk = (u: unknown, depth: number): void => {
    if (depth > 6 || u === null || typeof u !== "object") return;
    if (Array.isArray(u)) {
      for (const x of u) walk(x, depth + 1);
      return;
    }
    const o = u as Record<string, unknown>;
    const rel = o.relationships as
      | { contents?: { data?: unknown[] }; children?: { data?: unknown[] }; tabs?: { data?: unknown[] } }
      | undefined;
    const contents = rel?.contents?.data;
    if (Array.isArray(contents)) {
      const entries = entriesOf(contents as AmResource[]);
      if (entries.length) {
        const attrs = o.attributes as AmAttributes | undefined;
        const title =
          attrs?.title?.stringForDisplay ?? attrs?.name ?? `Section ${sections.length + 1}`;
        sections.push({ id: String(o.id ?? `g${sections.length}`), title, entries });
      }
      return;
    }
    // Descend into known relationship branches (tabs, children) and any
    // object values — the feed shape shifts between endpoints.
    for (const v of Object.values(o)) {
      walk(v, depth + 1);
    }
  };
  walk(data, 0);
  return sections;
}
