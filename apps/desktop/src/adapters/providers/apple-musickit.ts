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
import { ProviderEvalTimeout, ProviderSession } from "./provider-session.js";
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

  /** Back off re-installation after a failed attempt so capabilities()
   * doesn't spin a 30s wait on every poll. */
  private installBackoffUntil = 0;

  async prepare(): Promise<void> {
    await this.session.prepare();
    if (this.installed) return;
    if (Date.now() < this.installBackoffUntil) {
      throw new Error("Apple Music provider is still starting");
    }
    // The controller waits for MusicKit to appear — bounded well under the
    // 30s catalog IPC wait in the normal case.
    let ok: boolean;
    try {
      ok = await this.session.eval<boolean>(MUSICKIT_CONTROLLER_JS, 30_000);
    } catch (e) {
      this.installBackoffUntil = Date.now() + 15_000;
      throw e;
    }
    if (ok) {
      this.installed = true;
    } else {
      this.installBackoffUntil = Date.now() + 15_000;
    }
  }

  /** Run a controller call inside the page. Navigations wipe injected state;
   * the session re-installs on did-finish-load, so retry a transient miss.
   * Non-idempotent calls (POSTs, mutations) are never retried. */
  private async evalCtl<T>(call: string, opts: { retry?: boolean } = {}): Promise<T> {
    await this.prepare();
    try {
      return await this.session.eval<T>(`window.__cadenceCtl.${call}`);
    } catch (e) {
      if (opts.retry === false) throw e;
      // A timed-out page gets no retry — probing it costs another timeout.
      if (/timed out/i.test((e as Error).message)) throw e;
      // Retry only when the controller is actually missing — never on a call
      // that merely failed (a retried POST would run twice).
      const present = await this.session
        .eval<string>(`typeof window.__cadenceCtl`)
        .catch(() => "missing");
      if (present === "object" || present === "function") throw e;
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
      // Mutations are not idempotent — a timed-out POST may still land.
      { retry: method === undefined || method === "get" },
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

  private warming = false;
  /** Set by signOut so the view isn't rewarmed behind a signed-out user. */
  private signedOut = false;

  async capabilities(): Promise<RouteCapabilities> {
    // capabilities() must not boot the hidden view — the UI asks on every
    // launch. Report the last-known state; when the partition holds session
    // cookies, warm the view in the background so the real auth state
    // arrives via capabilitiesChanged shortly after.
    if (!this.installed) {
      // A user who just signed out must stay signed out — don't rewarm the
      // view off leftover cookies until they sign back in.
      if (!this.warming && !this.signedOut) {
        this.warming = true;
        void this.session
          .hasSessionCookies()
          // Re-check inside the continuation — signOut can land between the
          // cookie read and prepare().
          .then((has) => (has && !this.signedOut ? this.prepare() : undefined))
          .catch(() => undefined)
          .finally(() => {
            this.warming = false;
          });
      }
      return this.baseCapabilities({
        route: this.route,
        state: "unauthenticated",
        stateDetail: "Session not loaded yet — it activates on first use.",
      });
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
        // EME-encrypted streams are not exposed to WebAudio — PCM/EQ is
        // structurally impossible on this route, not merely unverified.
        pcmAccess: "no",
        eq: "no",
        replayGain: "no",
        qualityCeiling: "AAC per MusicKit web (no lossless/Atmos on web)",
      },
      visuals: { kind: "ambient" },
      canSignOut: true,
      notes: [
        "MusicKit JS in a music.apple.com ECS view (Sidra-style).",
        "Uses the site's own developer token — no paid Apple key.",
        "Full-track playback needs an Apple Music subscription.",
        "Radio stations can't seek or scrub — seek is ignored on stations.",
        "PCM/EQ/lossless access not established — do not assume.",
      ],
    });
  }

  async play(item: QueueItem, lease: PlaybackLease, opts: { positionMs?: number }): Promise<void> {
    this.session.setAudioMuted(false);
    this.generation = lease.generationId;
    this.installBackoffUntil = 0; // a real play request waits for install
    if (this.signedOut) throw new Error("Apple Music is signed out");
    // Run on the mirror chain — a pending playLater must land before the new
    // queue, and a prefetch queued during this play must wait for it. The
    // signedOut check runs again at execution: a sign-out that lands while
    // this play waits must cancel it, not reopen the session.
    return this.enqueueMirror(async () => {
      if (this.signedOut) throw new Error("Apple Music is signed out");
      const spec = specFor(item.track);
      // Read the mirror BEFORE clearing — the fast path skips inside
      // MusicKit's own queue when the coordinator's next lands on the
      // prefetched successor, instead of reloading the stream.
      const wasMirrored =
        (opts.positionMs ?? 0) === 0 &&
        this.mirrored.some((m) => m.queueId === item.queueId);
      this.mirrored = [];
      this.unknownNpId = null;
      this.tailStuckSince = 0;
      await this.prepare();
      try {
        this.current = { queueId: item.queueId, providerId: spec.id, station: spec.type === "station" };
        if (wasMirrored) {
          await this.evalCtl(`skipTo(${JSON.stringify(spec)})`);
        } else {
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
    });
  }

  /** Mirror operations are serialized — an in-flight playLater must not
   * land after a later clear, or the stale item re-enters the queue. */
  private mirrorChain: Promise<void> = Promise.resolve();

  private enqueueMirror(work: () => Promise<void>): Promise<void> {
    const next = this.mirrorChain.then(work, work);
    this.mirrorChain = next.catch(() => {});
    return next;
  }

  /** Mirror the coordinator's successor into the provider queue for gapless. */
  async prefetch(item: QueueItem): Promise<void> {
    if (!this.installed) return;
    const spec = specFor(item.track);
    return this.enqueueMirror(async () => {
      // Only the real successor may be mirrored — a replaced one must leave
      // the provider queue or it could still promote and play.
      const prior = this.mirrored.findIndex((m) => m.providerId === spec.id);
      if (prior >= 0) {
        // Same song under a new queueId — keep the provider-queue entry but
        // re-point bookkeeping at the new queue item.
        this.mirrored = [this.mirrored[prior]!];
        this.mirrored[0]!.queueId = item.queueId;
        return;
      }
      if (this.mirrored.length > 0) {
        this.mirrored = [];
        await this.session.eval(`window.__cadenceCtl.clearPlayLater()`).catch(() => {});
      }
      // A station has no track boundary — mirroring gains nothing and
      // MusicKit would report the stream's song id (not the station id).
      // While a station is current, the provider queue is the stream —
      // a mirrored song would play INSIDE it invisibly.
      if (spec.type === "station" || this.current?.station) return;
      // A second copy of the currently-playing song: don't append — if the
      // provider queue already holds one (it was in the loaded set) the
      // position-change promotion path adopts it; if not, the coordinator's
      // end-fallback plays it. Appending would add a third copy.
      if (spec.id === this.current?.providerId) {
        this.mirrored.push({ queueId: item.queueId, providerId: spec.id, station: false });
        return;
      }
      try {
        await this.session.eval(
          `window.__cadenceCtl.playLater(${JSON.stringify(spec)})`,
        );
        this.mirrored.push({ queueId: item.queueId, providerId: spec.id, station: false });
      } catch {
        // Mirroring is an optimization; failure only costs seamlessness.
      }
    });
  }

  async clearPrefetch(): Promise<void> {
    return this.enqueueMirror(async () => {
      this.mirrored = [];
      if (!this.installed) return;
      await this.session.eval(`window.__cadenceCtl.clearPlayLater()`).catch(() => {});
    });
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
    if (this.current?.station) return; // stations stream — nothing to seek
    await this.session.eval(`window.__cadenceCtl.seek(${Math.round(positionMs)})`).catch(() => {});
  }

  async setVolume(volume: number): Promise<void> {
    if (!this.installed) return;
    await this.session.eval(`window.__cadenceCtl.setVolume(${volume})`).catch(() => {});
  }

  async signIn(): Promise<void> {
    this.signedOut = false;
    this.installBackoffUntil = 0; // explicit user action clears backoff
    await this.prepare();
    if (this.authorized) {
      this.session.hide();
      return;
    }
    // A second Sign-in click while a flow is live doesn't stack another
    // authorize() or popup — it just brings the existing one forward.
    if (this.signInPending) {
      this.session.reveal();
      return;
    }
    this.signInPending = true;
    const attempt = ++this.signInAttempt;
    // Ownership ends on observable events only: auth completes, the popup
    // window closes, or the user signs out — never on a timer's guess.
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const endAttempt = () => {
      this.signInPending = false;
      if (hideTimer !== null) clearTimeout(hideTimer);
      offClose();
      offOpen();
    };
    // A popup counts as dismissed only when ALL popup windows are gone (the
    // flow can open children/grandchildren). The short grace lets a
    // successful auth's playerState land before we treat close as a cancel.
    const offClose = this.session.onPopupClosed(() => {
      if (this.session.hasOpenPopups || this.authorized || this.destroyed) return;
      hideTimer = setTimeout(() => {
        hideTimer = null;
        if (!this.authorized && !this.destroyed && attempt === this.signInAttempt) {
          endAttempt();
          this.session.hide();
          this.emit({ kind: "capabilitiesChanged" });
        }
      }, 2500);
    });
    const offOpen = this.session.onPopupOpened(() => {
      this.signInSawPopup = true;
    });
    this.signInSawPopup = false;
    this.signInCleanup = () => {
      endAttempt();
    };
    // MusicKit's authorize() opens Apple's own IDMSA sign-in popup in the
    // provider partition — the DOM click on the site's button is gesture-
    // gated and silently no-ops from injected code. Keep it as a fallback.
    // Don't await the popup — it can stay open minutes while the user types;
    // auth completion arrives through playerState → capabilitiesChanged.
    this.session.reveal();
    // 'timeout' is not a dismissal — the popup may still be open while the
    // user types; only a real rejection/false means the flow ended.
    const authed: Promise<true | false | "timeout"> = this.session
      .eval<boolean>(
        `window.__cadenceCtl.authorize().then((r) => r !== false).catch(() => false)`,
        120_000,
      )
      .catch((e) => (e instanceof ProviderEvalTimeout ? "timeout" : false));
    // Give authorize() a short window to fail fast — an immediate rejection
    // (no mk.authorize, dead page) needs a different recovery than a popup
    // that's simply waiting on the user.
    const SETTLED = Symbol("settled");
    const settledEarly =
      (await Promise.race([
        authed.then(() => SETTLED),
        new Promise<null>((r) => setTimeout(() => r(null), 5_000)),
      ])) === SETTLED;
    if (settledEarly && (await authed) === false) {
      // authorize() rejected immediately — try the page's own button; if
      // even that can't run, fail loudly so the UI can toast it.
      const clicked = await this.session
        .eval<boolean>(`window.__cadenceCtl.clickSignIn()`)
        .catch(() => false);
      if (!clicked) {
        endAttempt();
        this.session.hide();
        throw new Error("couldn't open Apple sign-in — try again");
      }
      // The fallback's own flow may be live — but it can also be a
      // gesture-gated no-op. If no popup materializes shortly, report the
      // failure instead of holding the attempt forever.
      setTimeout(() => {
        if (!this.signInSawPopup && attempt === this.signInAttempt && !this.authorized && !this.destroyed) {
          endAttempt();
          this.error("couldn't open Apple sign-in — try again", true);
        }
      }, 8_000);
      this.emit({ kind: "capabilitiesChanged" });
      return;
    }
    void authed.then((ok) => {
      if (ok === true && attempt === this.signInAttempt) {
        // authorize() resolved — completion lands via playerState next.
        endAttempt();
        this.emit({ kind: "capabilitiesChanged" });
        return;
      }
      // ok === false (rejected): the flow provably ended — release and hide.
      if (ok === false && attempt === this.signInAttempt) {
        endAttempt();
        if (!this.authorized && !this.destroyed) this.session.hide();
        this.emit({ kind: "capabilitiesChanged" });
      }
      // 'timeout': if the popup really is still open, keep the attempt owned
      // — its 'closed' event releases it. If no popup exists, the flow is
      // dead; release now or the Sign-in button stays locked forever.
      if (ok === "timeout" && !this.session.hasOpenPopups) {
        endAttempt();
        this.emit({ kind: "capabilitiesChanged" });
      }
    });
    this.emit({ kind: "capabilitiesChanged" });
  }

  /** Whether the current sign-in attempt produced a visible popup. */
  private signInSawPopup = false;

  /** A sign-in attempt is outstanding — suppress duplicate popups. */
  private signInPending = false;
  /** Monotonic id for the latest sign-in attempt — stale results drop. */
  private signInAttempt = 0;
  /** Ends the outstanding sign-in attempt (popup listener + pending flag). */
  private signInCleanup: (() => void) | null = null;

  async signOut(): Promise<void> {
    this.signedOut = true; // suppress lazy warm-up before/after clearing
    this.signInCleanup?.();
    this.signInCleanup = null;
    // Skip unauthorize when the view was never loaded — signing out cold
    // must not boot the window.
    if (this.installed) {
      try {
        await this.evalCtl(`unauthorize()`);
      } catch {
        /* unauthorize may not exist on this build — session clear covers it */
      }
    }
    this.authorized = false;
    // Kill the live view so the in-memory MusicKit instance can't keep an
    // authorized session alive; then clear the partition's stored data. A
    // live item can't outlive the session it plays from — end it so the
    // coordinator doesn't hold a dead lease.
    this.session.reset();
    this.installed = false;
    // 'stopped' — an unconditional teardown, not a queue-advance signal.
    // Emitted even with no adapter-side current item: the coordinator may
    // still hold a lease while its start request sits queued on the chain.
    this.emit({ kind: "stopped", generationId: this.generation });
    this.current = null;
    this.mirrored = [];
    this.unknownNpId = null;
    this.tailStuckSince = 0;
    let clearFailed = false;
    try {
      await this.session.clearData();
    } catch {
      clearFailed = true;
    }
    this.emit({ kind: "capabilitiesChanged" });
    if (clearFailed) {
      this.error("Apple Music session data could not be cleared — sign-out is partial", true);
      throw new Error("sign-out incomplete: provider session data could not be cleared");
    }
  }

  async dispose(): Promise<void> {
    this.destroyed = true;
    this.signInCleanup?.();
    this.signInCleanup = null;
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
      const msg =
        typeof data === "object" && data !== null && "message" in data && typeof (data as { message: unknown }).message === "string"
          ? (data as { message: string }).message.slice(0, 500)
          : "Apple Music error";
      return this.error(msg, true);
    }
    if (name === "nowPlaying") {
      const d = typeof data === "object" && data !== null ? (data as { id?: unknown; queuePos?: unknown }) : null;
      this.onNowPlaying(
        d !== null && typeof d.id === "string" ? d.id : null,
        d !== null && typeof d.queuePos === "number" ? d.queuePos : undefined,
      );
      return;
    }
    if (name !== "playerState") return;
    if (typeof data !== "object" || data === null) return;
    const s = data as PagePlayerState;
    if (typeof s.state !== "string") return; // forged/empty event — ignore
    if (s.isAuthorized !== this.authorized) {
      this.authorized = s.isAuthorized;
      if (this.authorized) {
        this.signInCleanup?.(); // a live sign-in attempt just completed
        this.session.hide(); // sign-in complete — tuck it away
      }
      this.emit({ kind: "capabilitiesChanged" });
    }
    // The engine ended the current track — the controller's `ended` flag is
    // terminal-state + position-at-tail, so transients and boundary-linger
    // states are already filtered. Stations are exempt: a stream pauses
    // between songs but never "ends".
    if (s.ended === true && !this.current?.station) {
      // If the engine already advanced to a mirrored successor by the time
      // this end-state arrived, it's a promotion — not an end. Ending the
      // promoted item here would stop playback mid-queue.
      if (typeof s.nowPlayingId === "string" && s.nowPlayingId !== this.current?.providerId) {
        this.onNowPlaying(s.nowPlayingId, s.queuePos);
        return;
      }
      if (this.current !== null) {
        this.emit({ kind: "ended", generationId, queueId: this.current.queueId });
      } else {
        this.emit({ kind: "ended", generationId });
      }
      return;
    }
    // Engine hung at the stream tail: MusicKit sometimes stalls 'playing' at
    // exactly the duration instead of advancing (seen with library items).
    // A real end can't run past duration, so treat a persistent tail-stall
    // as the end it was supposed to report.
    if (
      this.current !== null &&
      !this.current.station &&
      s.state === "playing" &&
      s.durationMs > 0 &&
      s.positionMs >= s.durationMs - 500 &&
      (s.nowPlayingId === null || s.nowPlayingId === this.current.providerId)
    ) {
      if (this.tailStuckSince === 0) {
        this.tailStuckSince = Date.now();
      } else if (Date.now() - this.tailStuckSince > 2500) {
        this.tailStuckSince = 0;
        this.emit({ kind: "ended", generationId, queueId: this.current.queueId });
        return;
      }
    } else {
      this.tailStuckSince = 0;
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
  private onNowPlaying(id: string | null, queuePos?: number): void {
    if (id === null) return;
    if (this.current === null) {
      // Playback started inside the page itself (user clicked play during
      // sign-in) — nothing owns it, so pause it before the window hides.
      void this.session.eval(`window.__cadenceCtl.pause()`).catch(() => {});
      return;
    }
    if (id === this.current.providerId) {
      // Same id at a NEW queue position = MusicKit promoted a second copy
      // of the song (a duplicate entry) — treat it as a mirror promotion.
      const dup = this.mirrored.findIndex((m) => m.providerId === id);
      if (dup === -1 || queuePos === undefined) return;
      this.promoteMirror(dup);
      return;
    }
    // A station streams its constituent songs as a rolling nowPlayingItem —
    // Cadence keeps it as ONE queue item; item changes inside the stream are
    // not promotions and must not end the queue item.
    if (this.current.station) return;
    const hit = this.mirrored.findIndex((m) => m.providerId === id);
    if (hit === -1) {
      // Unrecognized item playing. A transient id during a queue transition
      // must not pause the item that's about to be promoted — confirm the
      // same id is still now-playing a beat later before acting.
      if (this.unknownNpId === id) {
        this.unknownNpId = null;
        void this.session.eval(`window.__cadenceCtl.pause()`).catch(() => {});
        this.emit({ kind: "ended", generationId: this.generation, queueId: this.current.queueId });
      } else {
        this.unknownNpId = id;
        // The controller only emits on change — a stable unrecognized item
        // gets one sighting, so probe once to confirm persistence. Bind the
        // probe to the generation+item that scheduled it; a late response
        // must never act on a newer playback request.
        const gen = this.generation;
        const qid = this.current.queueId;
        setTimeout(() => {
          if (
            this.destroyed ||
            this.unknownNpId !== id ||
            this.current === null ||
            this.current.queueId !== qid ||
            this.generation !== gen
          ) {
            return;
          }
          void this.session
            .eval<{ id: string | null }>(`window.__cadenceCtl.npId()`)
            .then((np) => {
              if (this.generation !== gen || this.current?.queueId !== qid) return;
              if (np.id === id) this.onNowPlaying(id);
              else if (this.unknownNpId === id) this.unknownNpId = null;
            })
            .catch(() => {
              if (this.unknownNpId === id) this.unknownNpId = null;
            });
        }, 1500);
      }
      return;
    }
    this.unknownNpId = null;
    this.promoteMirror(hit);
  }

  /** Last unrecognized nowPlaying id — needs two sightings before ending. */
  private unknownNpId: string | null = null;
  /** When the page first reported playback stuck at the stream tail. */
  private tailStuckSince = 0;

  private promoteMirror(hit: number): void {
    if (this.current === null) return;
    this.unknownNpId = null;
    this.tailStuckSince = 0;
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
