/**
 * YouTube Music route adapter.
 *
 * Playback: a hidden, account-scoped ECS view running music.youtube.com with
 * the injected controller (see inject/ytm-controller.ts). We drive the real
 * player: navigate to the video and control the media element — the same
 * approach as Kaset/Pear. Correct-song-over-gapless on any doubt.
 *
 * Catalog: youtubei.js (Innertube) reusing the session's cookies so browse and
 * playback stay tied to one account. Search is implemented; when the page or
 * parsing breaks, the caller can fall back to the provider page itself.
 */

import type { AdapterEvent, PlaybackLease, QueueItem, RouteCapabilities } from "@cadence/protocol";
import { ProviderViewAdapter } from "./provider-adapter-base.js";
import { ProviderSession } from "./provider-session.js";
import { YTM_CONTROLLER_JS } from "./inject/ytm-controller.js";

interface YtmPlayerState {
  state: "idle" | "playing" | "paused" | "buffering" | "ended";
  positionMs: number;
  durationMs: number;
  volume: number;
  title: string;
  byline: string;
  url: string;
}

export class YouTubeMusicAdapter extends ProviderViewAdapter {
  readonly route = "youtube-music" as const;
  private session: ProviderSession;
  private generation = 0;
  private signedIn: boolean | null = null;
  private destroyed = false;

  constructor() {
    super();
    this.session = new ProviderSession({
      partition: "persist:provider-youtube",
      url: "https://music.youtube.com",
      onEvent: (e) => this.onPageEvent(e.name, e.data),
    });
  }

  async prepare(): Promise<void> {
    await this.session.prepare();
    await this.session.eval(YTM_CONTROLLER_JS);
    try {
      this.signedIn = await this.session.eval<boolean>(`window.__cadenceCtl.isSignedIn()`);
      this.emit({ kind: "capabilitiesChanged" });
    } catch {
      /* controller may not be ready yet; state stays unknown */
    }
  }

  async capabilities(): Promise<RouteCapabilities> {
    const signedIn = this.signedIn;
    return this.baseCapabilities({
      state: this.session.alive
        ? signedIn === false
          ? "unauthenticated"
          : "ready"
        : "unauthenticated",
      stateDetail:
        signedIn === false
          ? "Not signed in to YouTube Music — open the sign-in view."
          : signedIn === null
            ? "Sign-in state unknown until the player view loads."
            : undefined,
      playback: {
        engine: "provider-engine",
        canPlay: true,
        canPause: true,
        canSeek: true,
        canNextPrevious: true,
        // We navigate per track; seamlessness is not established.
        gapless: "unknown",
        exclusiveOutput: "no",
      },
      audio: {
        pcmAccess: "unknown",
        eq: "unknown",
        replayGain: "no",
        qualityCeiling: "provider-selected opus (~256kbps typical)",
      },
      visuals: { kind: "ambient" },
      notes: [
        "Playback runs the real music.youtube.com player in a hidden view.",
        "Per-track navigation prefers the correct song and accepts a gap.",
        "PCM/EQ access varies by media and runtime — not established.",
      ],
    });
  }

  async play(item: QueueItem, lease: PlaybackLease, opts: { positionMs?: number }): Promise<void> {
    this.generation = lease.generationId;
    await this.prepare();
    if (item.track.source.kind !== "provider") throw new Error("not a provider track");
    const id = item.track.source.providerItemId;
    try {
      await this.session.eval(
        `window.__cadenceCtl.play(${JSON.stringify(id)}, ${opts.positionMs ?? 0})`,
      );
      this.emit({ kind: "started", generationId: lease.generationId, durationMs: item.track.durationMs });
    } catch (e) {
      this.error(`YouTube Music play failed: ${(e as Error).message}`, true);
      throw e;
    }
  }

  async pause(lease: PlaybackLease): Promise<void> {
    if (lease.generationId !== this.generation) return;
    await this.session.eval(`window.__cadenceCtl.pause()`).catch(() => {});
  }

  async resume(lease: PlaybackLease): Promise<void> {
    if (lease.generationId !== this.generation) return;
    await this.session.eval(`window.__cadenceCtl.resume()`).catch(() => {});
  }

  /** Confirmed silence: pause the media element. Session stays logged in. */
  async stop(lease: PlaybackLease): Promise<void> {
    if (lease.generationId !== this.generation) return;
    await this.session.eval(`window.__cadenceCtl.pause()`).catch(() => {});
  }

  async seek(lease: PlaybackLease, positionMs: number): Promise<void> {
    if (lease.generationId !== this.generation) return;
    await this.session.eval(`window.__cadenceCtl.seek(${Math.round(positionMs)})`).catch(() => {});
  }

  async setVolume(volume: number): Promise<void> {
    await this.session.eval(`window.__cadenceCtl.setVolume(${volume})`).catch(() => {});
  }

  async releaseIdle(): Promise<void> {
    // Keep the view — teardown costs a re-login risk; idle views are cheap.
  }

  async dispose(): Promise<void> {
    this.destroyed = true;
    await this.session.dispose();
  }

  /** Sign-in flow: reveal the hidden view so the user can authenticate. */
  async signIn(): Promise<void> {
    await this.prepare();
    this.session.reveal();
  }

  private onPageEvent(name: string, data: unknown): void {
    if (this.destroyed) return;
    if (name === "viewGone") {
      this.error("YouTube Music view crashed", true);
      return;
    }
    if (name !== "playerState") return;
    const s = data as YtmPlayerState;
    const generationId = this.generation;
    if (s.state === "ended") {
      this.emit({ kind: "ended", generationId });
      return;
    }
    this.emit({
      kind: "position",
      positionMs: s.positionMs,
      atMs: Date.now(),
      generationId,
    });
    this.emit({
      kind: "state",
      status:
        s.state === "playing" ? "playing" : s.state === "buffering" ? "buffering" : "paused",
      generationId,
    });
  }
}
