/**
 * YouTube Music catalog via youtubei.js (InnerTube). Used for search and
 * browsing; playback always runs through the real provider page per the v3
 * design. Cookies from the provider session partition are passed through so
 * catalog and playback stay on one account.
 *
 * Parsing changes upstream are a known risk: every failure throws a typed
 * CatalogError so callers can fall back to the provider page itself.
 */

import type { ArtistRef, ArtworkRef, TrackRef } from "@cadence/protocol";

export class CatalogError extends Error {
  constructor(
    message: string,
    readonly retriable: boolean,
  ) {
    super(message);
  }
}

export interface YtmCatalogDeps {
  /** Cookie header captured from the provider session partition, if any. */
  getCookieHeader?: () => Promise<string | undefined>;
}

interface YtmSearchHit {
  videoId?: string;
  title?: string;
  artists?: { name: string }[];
  album?: string;
  durationMs?: number;
  thumbnails?: { url: string; width?: number; height?: number }[];
}

export class YouTubeMusicCatalog {
  private innertube: unknown = null;

  constructor(private deps: YtmCatalogDeps = {}) {}

  private async client(): Promise<{
    music: { search(q: string, opts?: { type?: string }): Promise<unknown> };
  }> {
    if (this.innertube) return this.innertube as never;
    // Lazy import so the desktop app can load without youtubei.js present.
    const mod = await import("youtubei.js");
    const cookie = await this.deps.getCookieHeader?.().catch(() => undefined);
    this.innertube = await mod.Innertube.create({
      ...(cookie ? { cookie } : {}),
      generate_session_locally: true,
    });
    return this.innertube as never;
  }

  async searchTracks(query: string, limit = 25): Promise<TrackRef[]> {
    try {
      const it = await this.client();
      const res = (await it.music.search(query, { type: "song" })) as {
        contents?: { contents?: unknown[] };
      };
      const out: TrackRef[] = [];
      const items = flatten(res);
      for (const raw of items) {
        const hit = normalizeHit(raw);
        if (!hit?.videoId) continue;
        out.push({
          id: `youtube-music:${hit.videoId}`,
          route: "youtube-music",
          provider: "youtube",
          title: hit.title ?? "Unknown title",
          artists: (hit.artists ?? []).map<ArtistRef>((a) => ({ name: a.name })),
          ...(hit.album ? { album: hit.album } : {}),
          durationMs: hit.durationMs ?? 0,
          ...(hit.thumbnails?.length
            ? { artwork: bestThumb(hit.thumbnails) }
            : {}),
          source: { kind: "provider", providerItemId: hit.videoId },
          availability: "unknown",
        });
        if (out.length >= limit) break;
      }
      return out;
    } catch (e) {
      throw new CatalogError(`InnerTube search failed: ${(e as Error).message}`, true);
    }
  }
}

export function flatten(res: { contents?: { contents?: unknown[] } }): unknown[] {
  const out: unknown[] = [];
  for (const shelf of res.contents?.contents ?? []) {
    const s = shelf as { contents?: unknown[] };
    if (Array.isArray(s.contents)) out.push(...s.contents);
  }
  return out;
}

export function normalizeHit(raw: unknown): YtmSearchHit | null {
  const r = raw as {
    video_id?: string;
    videoId?: string;
    title?: { text?: string } | string;
    subtitle?: { text?: string };
    duration?: { seconds?: number } | number;
    thumbnails?: { url: string; width?: number; height?: number }[];
    flex_columns?: unknown[];
  };
  const videoId = r.video_id ?? r.videoId;
  if (!videoId) return null;
  const title = typeof r.title === "string" ? r.title : r.title?.text;
  const byline = r.subtitle?.text ?? "";
  const durationS =
    typeof r.duration === "number" ? r.duration : r.duration?.seconds;
  return {
    videoId,
    title: title ?? undefined,
    artists: byline
      ? byline
          .split("•")[0]!
          .split(",")
          .map((name) => ({ name: name.trim() }))
          .filter((a) => a.name.length > 0)
      : undefined,
    durationMs: durationS ? durationS * 1000 : undefined,
    thumbnails: r.thumbnails,
  };
}

export function bestThumb(thumbs: { url: string; width?: number; height?: number }[]): ArtworkRef {
  const t = [...thumbs].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]!;
  return { url: t.url, ...(t.width ? { width: t.width } : {}), ...(t.height ? { height: t.height } : {}) };
}
