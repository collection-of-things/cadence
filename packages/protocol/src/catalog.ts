/**
 * Catalog surface — the provider-neutral browsing model.
 *
 * Cadence is a client for ONE streaming platform at a time: when Apple Music
 * (or later YouTube Music / Spotify) is the active platform, every shelf and
 * page the UI renders comes through this one request/response shape. Each
 * route adapter may implement `catalog(req)`; adapters that don't simply
 * leave it undefined and the UI reports "not available" honestly.
 */

import type { ArtistRef, ArtworkRef, ProviderId, RouteId, TrackRef } from "./index.js";

/** The active streaming platform. "local" = local files only. */
export type PlatformId = ProviderId;

/** Kinds of content a section can hold. */
export type CatalogEntryKind = "song" | "album" | "playlist" | "artist" | "station";

/**
 * One request against a route's catalog. Responses are always a CatalogPage —
 * even mutations (addToLibrary) reply with an (empty) page so IPC stays unary.
 */
export type CatalogRequest =
  | { kind: "search"; text: string; types?: CatalogEntryKind[]; limit?: number; offset?: number }
  /** Personalized home — Apple "Listen Now" (falls back to browse when signed out). */
  | { kind: "home" }
  /** Editorial browse sections. */
  | { kind: "browse" }
  /** Radio stations. */
  | { kind: "radio" }
  /** A catalog album page (header + track section). */
  | { kind: "album"; id: string }
  /** A catalog playlist page. */
  | { kind: "playlist"; id: string }
  /** An artist page (top songs, albums, similar). */
  | { kind: "artist"; id: string }
  /** The user's library, one type at a time, paginated. */
  | {
      kind: "library";
      collection: "songs" | "albums" | "artists" | "playlists";
      offset?: number;
      limit?: number;
    }
  /** A user-library album or playlist detail page (uses the library id). */
  | { kind: "libraryDetail"; collection: "albums" | "playlists"; id: string }
  /** Lyrics for a catalog song, as LRC text when synced lines exist. */
  | { kind: "lyrics"; songId: string }
  /** Add items to the user's library. */
  | {
      kind: "addToLibrary";
      ids: Partial<Record<"songs" | "albums" | "playlists" | "music-videos", string[]>>;
    };

/** A container (album/playlist) reference inside a section. */
export interface CatalogContainer {
  kind: "album" | "playlist";
  id: string;
  route: RouteId;
  provider: ProviderId;
  title: string;
  /** Artist name for albums, curator for playlists. */
  subtitle?: string;
  artwork?: ArtworkRef;
  itemCount?: number;
  year?: number;
  /** True when the id addresses the user's library, not the catalog. */
  isLibraryItem?: boolean;
}

export interface CatalogArtist {
  kind: "artist";
  id: string;
  route: RouteId;
  provider: ProviderId;
  name: string;
  artwork?: ArtworkRef;
}

export interface CatalogStation {
  kind: "station";
  id: string;
  route: RouteId;
  provider: ProviderId;
  name: string;
  subtitle?: string;
  artwork?: ArtworkRef;
}

export type CatalogEntry =
  | { kind: "song"; track: TrackRef }
  | { kind: "album"; album: CatalogContainer }
  | { kind: "playlist"; playlist: CatalogContainer }
  | { kind: "artist"; artist: CatalogArtist }
  | { kind: "station"; station: CatalogStation };

/** One shelf/section on a catalog page. */
export interface CatalogSection {
  id: string;
  title: string;
  /** Provider-supplied subtitle, e.g. "Because you listened to X". */
  subtitle?: string;
  entries: CatalogEntry[];
}

/** A page of catalog content — the single response shape for every request. */
export interface CatalogPage {
  /** Page-level header (album/playlist/artist detail). */
  title?: string;
  subtitle?: string;
  artwork?: ArtworkRef;
  sections: CatalogSection[];
  /** Present when more content is available via the same request + offset. */
  nextOffset?: number;
  /** Lyrics payload for {kind:'lyrics'} — LRC text, or plain text. */
  lyrics?: string;
  /** True when entries were cut at an internal cap — the list is partial. */
  truncated?: boolean;
}

/**
 * A station entry -> a playable pseudo-track. Stations stream continuously;
 * the provider adapter decodes the `am:station:` URI on play.
 */
export function stationToTrack(station: CatalogStation): TrackRef {
  const track: TrackRef = {
    id: `${station.route}:station:${station.id}`,
    route: station.route,
    provider: station.provider,
    title: station.name,
    artists: [{ name: "Radio" }],
    durationMs: 0,
    source: {
      kind: "provider",
      providerItemId: station.id,
      uri: `am:station:${station.id}`,
    },
    availability: "available",
  };
  if (station.artwork) track.artwork = station.artwork;
  if (station.subtitle) track.availabilityDetail = station.subtitle;
  return track;
}
