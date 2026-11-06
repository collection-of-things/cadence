/**
 * Apple Music route adapter.
 *
 * Runs MusicKit JS inside music.apple.com in a hidden ECS view (Sidra
 * precedent). The page ships its own developer token and configures its own
 * MusicKit instance, so no paid Apple Developer Program key is involved
 * anywhere: `MusicKit.getInstance()` gives us the SDK for free, and the user
 * authorizes it by signing into music.apple.com in the revealed view.
 *
 * Queue model: the coordinator owns queue truth; the adapter mirrors only the
 * immediate successor into MusicKit's own queue via playLater so track
 * boundaries can advance inside the provider engine (gapless-style). When
 * MusicKit promotes a mirrored item itself, the adapter reports it through
 * `ended` + promoted `started` events — the coordinator's promotion path
 * adopts the already-playing track.
 */

import type {
  CatalogPage,
  CatalogRequest,
  PlaybackLease,
  QueueItem,
  RouteCapabilities,
  TrackRef,
} from "@cadence/protocol";
import { ProviderViewAdapter } from "./provider-adapter-base.js";
import { ProviderSession } from "./provider-session.js";
import { MUSICKIT_CONTROLLER_JS } from "./inject/musickit-controller.js";
import { AppleMusicCatalog } from "./apple-music-catalog.js";

interface QueueSpec {
  type: "song" | "library-song" | "station" | "album" | "playlist";
  id: string;
}

/** Event names the injected controller is allowed to push through the bridge. */
const PAGE_EVENT_NAMES = new Set([
  "playerState",
  "nowPlaying",
  "viewGone",
  "error",
  "needDeveloperToken",
]);

/** Decode the item's source into a MusicKit queue spec. */
function specFor(track: TrackRef): QueueSpec {
  const uri = track.source.kind === "provider" ? track.source.uri : undefined;
  if (uri?.startsWith("am:station:")) return { type: "station", id: uri.slice("am:station:".length) };
  if (uri?.startsWith("am:library-song:")) {
    return { type: "library-song", id: uri.slice("am:library-song:".length) };
  }
  if (track.source.kind !== "provider") throw new Error("not a provider track");
  return { type: "song", id: track.source.providerItemId };
}

interface PagePlayerState {
  state: string;
  positionMs: number;
  durationMs: number;
  isAuthorized: boolean;
  nowPlayingId: string | null;
  queuePos: number;
  queueLen: number;
  nextItemId: string | null;
  ended: boolean;
}

export class AppleMusicKitAdapter extends ProviderViewAdapter {
  readonly route = "apple-musickit" as const;
  private readonly session: ProviderSession;
  private readonly catalogService = new AppleMusicCatalog({
    amp: (path, params, method) => this.amp(path, params, method),
    storefront: async () => this.evalCtl<string>("storefront()"),
  });
  private generation = 0;
  private authorized = false;
  private installed = false;
  private destroyed = false;
  /** queueId+provider id of the item we told MusicKit to play. */
  private current: { queueId: string; providerId: string; station: boolean } | null = null;
  /** Successors mirrored into the MusicKit queue, in append order. */
  private mirrored: { queueId: string; providerId: string; station: boolean }[] = [];

  constructor() {
    super();
    this.session = new ProviderSession({
      partition: "persist:provider-apple",
      url: "https://music.apple.com/us/browse",
      injectScript: MUSICKIT_CONTROLLER_JS,
      onEvent: (e) => this.onPageEvent(e.name, e.data),
    });
  }

  async prepare(): Promise<void> {
    await this.session.prepare();
    if (this.installed) return;
    // The controller waits for MusicKit to appear — allow well past the
    // normal 10s eval cap, but still bounded.
    const ok = await this.session.eval<boolean>(MUSICKIT_CONTROLLER_JS, 90_000);
    if (ok) this.installed = true;
  }

  /** Run a controller call inside the page. Navigations wipe injected state;
   * the session re-installs on did-finish-load, so retry a transient miss. */
  private async evalCtl<T>(call: string): Promise<T> {
    await this.prepare();
    try {
      return await this.session.eval<T>(`window.__cadenceCtl.${call}`);
    } catch (e) {
      if (!/undefined|__cadenceCtl|not a function/i.test((e as Error).message)) throw e;
      await new Promise((r) => setTimeout(r, 800));
      this.installed = false;
      await this.prepare();
      return this.session.eval<T>(`window.__cadenceCtl.${call}`);
    }
  }

  private async amp(
    path: string,
    params?: Record<string, string | number>,
    method?: "get" | "post" | "delete",
  ): Promise<unknown> {
    return this.evalCtl(
      `amp(${JSON.stringify(path)}, ${JSON.stringify(params ?? {})}, ${JSON.stringify(method ?? "get")})`,
    );
  }

  async catalog(req: CatalogRequest): Promise<CatalogPage> {
    await this.prepare();
    return this.catalogService.query(req);
  }

  async search(text: string): Promise<TrackRef[]> {
    const page = await this.catalog({
      kind: "search",
      text,
      types: ["song"],
      limit: 25,
    });
    const tracks: TrackRef[] = [];
    for (const section of page.sections) {
      for (const entry of section.entries) {
        if (entry.kind === "song") tracks.push(entry.track);
      }
    }
    return tracks;
  }

  async capabilities(): Promise<RouteCapabilities> {
    if (!this.installed) {
      try {
        await this.prepare();
      } catch (e) {
        console.error('[apple] prepare failed:', e);
        return this.baseCapabilities({
          route: this.route,
          state: "unavailable",
          stateDetail: "Could not load music.apple.com in the provider view.",
          notes: ["music.apple.com unreachable or MusicKit missing — check network."],
        });
      }
    }
    return this.baseCapabilities({
      route: this.route,
      state: this.authorized ? "ready" : "unauthenticated",
      ...(this.authorized
        ? {}
        : {
            stateDetail:
              "Sign into Apple Music — the music.apple.com window opens on Apple's own page.",
          }),
      playback: {
        engine: "provider-engine",
        canPlay: true,
        canPause: true,
        canSeek: true,
        canNextPrevious: true,
        gapless: "unknown",
        exclusiveOutput: "no",
      },
      audio: {
        pcmAccess: "unknown",
        eq: "unknown",
        replayGain: "no",
        qualityCeiling: "provider-selected AAC/ALAC per account settings",
      },
      visuals: { kind: "ambient" },
      notes: [
        "MusicKit JS in a music.apple.com ECS view (Sidra-style).",
        "Uses the site's own developer token — no paid Apple key.",
        "Full-track playback needs an Apple Music subscription.",
        "PCM/EQ/lossless access not established — do not assume.",
      ],
    });
  }

  async play(item: QueueItem, lease: PlaybackLease, opts: { positionMs?: number }): Promise<void> {
    this.session.setAudioMuted(false);
    this.generation = lease.generationId;
    await this.prepare();
    const spec = specFor(item.track);
    try {
      // Fast path: the coordinator's "next" lands on the mirrored successor —
      // skip inside MusicKit's own queue instead of reloading the stream.
      if ((opts.positionMs ?? 0) === 0 && this.mirrored.some((m) => m.queueId === item.queueId)) {
        this.current = { queueId: item.queueId, providerId: spec.id, station: spec.type === "station" };
        this.mirrored = [];
        await this.evalCtl(`skipTo(${JSON.stringify(spec)})`);
      } else {
        this.current = { queueId: item.queueId, providerId: spec.id, station: spec.type === "station" };
        this.mirrored = [];
        await this.evalCtl(
          `play(${JSON.stringify(spec)}, ${Math.max(0, Math.round(opts.positionMs ?? 0))})`,
        );
      }
      this.emit({
        kind: "started",
        generationId: lease.generationId,
        durationMs: item.track.durationMs,
      });
    } catch (e) {
      this.error(`Apple Music play failed: ${(e as Error).message}`, true);
      throw e;
    }
  }

  /** Mirror the coordinator's successor into the provider queue for gapless. */
  async prefetch(item: QueueItem): Promise<void> {
    if (!this.installed) return;
    const spec = specFor(item.track);
    if (this.mirrored.some((m) => m.providerId === spec.id)) return;
    try {
      await this.session.eval(
        `window.__cadenceCtl.playLater(${JSON.stringify(spec)})`,
      );
      this.mirrored.push({ queueId: item.queueId, providerId: spec.id, station: spec.type === "station" });
    } catch {
      // Mirroring is an optimization; failure only costs seamlessness.
    }
  }

  async clearPrefetch(): Promise<void> {
    this.mirrored = [];
    if (!this.installed) return;
    await this.session.eval(`window.__cadenceCtl.clearPlayLater()`).catch(() => {});
  }

  async pause(lease: PlaybackLease): Promise<void> {
    if (lease.generationId !== this.generation) return;
    await this.session.eval(`window.__cadenceCtl.pause()`).catch(() => {});
  }

  async resume(lease: PlaybackLease): Promise<void> {
    if (lease.generationId !== this.generation) return;
    await this.session.eval(`window.__cadenceCtl.resume()`).catch(() => {});
  }

  async stop(lease: PlaybackLease): Promise<void> {
    this.session.setAudioMuted(true);
    if (lease.generationId !== this.generation) return;
    // The coordinator's handoff counts on confirmed silence — propagate
    // failures instead of leaving a second source audible.
    await this.session.eval(`window.__cadenceCtl.pause()`);
  }

  async seek(lease: PlaybackLease, positionMs: number): Promise<void> {
    if (lease.generationId !== this.generation) return;
    await this.session.eval(`window.__cadenceCtl.seek(${Math.round(positionMs)})`).catch(() => {});
  }

  async setVolume(volume: number): Promise<void> {
    if (!this.installed) return;
    await this.session.eval(`window.__cadenceCtl.setVolume(${volume})`).catch(() => {});
  }

  async signIn(): Promise<void> {
    await this.prepare();
    // The user signs into music.apple.com on Apple's own page — our window,
    // their site, their credentials. MusicKit auth follows the site session.
    this.session.reveal();
    await this.session.eval(`window.__cadenceCtl.clickSignIn()`).catch(() => {});
  }

  async signOut(): Promise<void> {
    try {
      await this.evalCtl(`unauthorize()`);
    } catch {
      /* unauthorize may not exist on this build — session clear covers it */
    }
    this.authorized = false;
    // Kill the live view so the in-memory MusicKit instance can't keep an
    // authorized session alive; then clear the partition's stored data.
    this.session.reset();
    this.installed = false;
    this.current = null;
    this.mirrored = [];
    let clearFailed = false;
    try {
      await this.session.clearData();
    } catch {
      clearFailed = true;
    }
    this.emit({ kind: "capabilitiesChanged" });
    if (clearFailed) {
      this.error("Apple Music session data could not be cleared — sign-out is partial", true);
    }
  }

  async dispose(): Promise<void> {
    this.destroyed = true;
    await this.session.dispose();
  }

  private onPageEvent(name: string, data: unknown): void {
    if (this.destroyed) return;
    const generationId = this.generation;
    // The bridge accepts page-originated events — only honor the narrow set
    // the controller is designed to post.
    if (!PAGE_EVENT_NAMES.has(name)) return;
    if (name === "viewGone") return this.error("Apple Music view crashed", true);
    if (name === "needDeveloperToken") {
      this.emit({ kind: "capabilitiesChanged" });
      return;
    }
    if (name === "error") {
      const d = data as { message?: string };
      return this.error(typeof d.message === "string" ? d.message.slice(0, 500) : "Apple Music error", true);
    }
    if (name === "nowPlaying") {
      const d = data as { id?: unknown };
      this.onNowPlaying(typeof d.id === "string" ? d.id : null);
      return;
    }
    if (name !== "playerState") return;
    const s = data as PagePlayerState;
    if (s.isAuthorized !== this.authorized) {
      this.authorized = s.isAuthorized;
      if (this.authorized) this.session.hide(); // sign-in complete — tuck it away
      this.emit({ kind: "capabilitiesChanged" });
    }
    // The engine ended the current track (queue exhausted or state 'ended').
    if (s.ended || s.state === "ended" || s.state === "stopped") {
      if (this.current !== null) {
        this.emit({ kind: "ended", generationId, queueId: this.current.queueId });
      } else {
        this.emit({ kind: "ended", generationId });
      }
      return;
    }
    this.emit({ kind: "position", positionMs: s.positionMs, atMs: Date.now(), generationId });
    this.emit({
      kind: "state",
      status: s.state === "playing" ? "playing" : s.state === "buffering" ? "buffering" : "paused",
      generationId,
    });
  }

  /**
   * MusicKit advanced to a new nowPlayingItem. When it matches a mirrored
   * successor, the provider engine itself carried the boundary — report it as
   * a gapless end + promoted start so the coordinator adopts the lease.
   */
  private onNowPlaying(id: string | null): void {
    if (id === null || this.current === null) return;
    if (id === this.current.providerId) return;
    // A station streams its constituent songs as a rolling nowPlayingItem —
    // Cadence keeps it as ONE queue item; item changes inside the stream are
    // not promotions and must not end the queue item.
    if (this.current.station) return;
    const hit = this.mirrored.findIndex((m) => m.providerId === id);
    if (hit === -1) {
      // Something else started inside the provider queue (leftover state,
      // external edit). Report the current item ended so the coordinator's
      // fallback drives the real successor instead of drifting.
      this.emit({ kind: "ended", generationId: this.generation, queueId: this.current.queueId });
      return;
    }
    const promoted = this.mirrored[hit]!;
    this.mirrored = this.mirrored.slice(hit + 1);
    const previous = this.current;
    this.current = promoted;
    this.emit({
      kind: "ended",
      generationId: this.generation,
      queueId: previous.queueId,
      gapless: true,
    });
    this.emit({
      kind: "started",
      generationId: this.generation,
      queueId: promoted.queueId,
      promoted: true,
    });
  }
}
