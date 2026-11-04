/**
 * Apple Music route adapter.
 *
 * Runs MusicKit JS inside music.apple.com in a hidden ECS view (Sidra
 * precedent). A developer token is required for MusicKit configuration: the
 * app fetches a signed JWT from a configurable endpoint
 * (CADENCE_APPLE_TOKEN_ENDPOINT or settings). Without it the route reports
 * 'unauthenticated' honestly — the wiring is complete, the account is not.
 */

import type { PlaybackLease, QueueItem, RouteCapabilities } from "@cadence/protocol";
import { ProviderViewAdapter } from "./provider-adapter-base.js";
import { ProviderSession } from "./provider-session.js";
import { MUSICKIT_CONTROLLER_JS } from "./inject/musickit-controller.js";

export interface AppleMusicAdapterDeps {
  /** Fetch a signed Apple developer token (JWT). Return null when unset. */
  getDeveloperToken?: () => Promise<string | null>;
}

export class AppleMusicKitAdapter extends ProviderViewAdapter {
  readonly route = "apple-musickit" as const;
  private session: ProviderSession;
  private generation = 0;
  private authorized = false;
  private installed = false;
  private destroyed = false;

  constructor(private deps: AppleMusicAdapterDeps = {}) {
    super();
    this.session = new ProviderSession({
      partition: "persist:provider-apple",
      url: "https://music.apple.com",
      onEvent: (e) => this.onPageEvent(e.name, e.data),
    });
  }

  private async developerToken(): Promise<string | null> {
    try {
      return (await this.deps.getDeveloperToken?.()) ?? null;
    } catch {
      return null;
    }
  }

  async prepare(): Promise<void> {
    await this.session.prepare();
    if (this.installed) return;
    const token = await this.developerToken();
    const ok = await this.session.eval<boolean>(
      `(${MUSICKIT_CONTROLLER_JS})(${JSON.stringify(token)})`,
    );
    if (ok) this.installed = true;
  }

  async capabilities(): Promise<RouteCapabilities> {
    const token = await this.developerToken();
    const needsToken = !token && !this.installed;
    return this.baseCapabilities({
      route: this.route,
      state: needsToken ? "unauthenticated" : this.authorized ? "ready" : "unauthenticated",
      ...(needsToken
        ? { stateDetail: "No Apple developer token endpoint configured." }
        : this.authorized
          ? {}
          : { stateDetail: "Apple Music account not authorized in the embedded player." }),
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
        "Requires a server-signed developer token + user authorization.",
        "PCM/EQ/lossless access not established — do not assume.",
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
      this.error(`Apple Music play failed: ${(e as Error).message}`, true);
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

  async stop(lease: PlaybackLease): Promise<void> {
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
    await this.session.eval(`window.__cadenceCtl.setVolume(${volume})`).catch(() => {});
  }

  async signIn(): Promise<void> {
    await this.prepare();
    // MusicKit authorize() must run from a user gesture context; revealing
    // the view lets the user complete Apple's sign-in interactively.
    this.session.reveal();
    await this.session.eval(`window.__cadenceCtl.authorize()`).catch(() => {});
  }

  async dispose(): Promise<void> {
    this.destroyed = true;
    await this.session.dispose();
  }

  private onPageEvent(name: string, data: unknown): void {
    if (this.destroyed) return;
    const generationId = this.generation;
    if (name === "viewGone") return this.error("Apple Music view crashed", true);
    if (name === "needDeveloperToken") {
      this.emit({ kind: "capabilitiesChanged" });
      return;
    }
    if (name === "error") {
      const d = data as { message?: string };
      return this.error(d.message ?? "Apple Music error", true);
    }
    if (name !== "playerState") return;
    const s = data as {
      state: string;
      positionMs: number;
      durationMs: number;
      isAuthorized: boolean;
    };
    if (s.isAuthorized !== this.authorized) {
      this.authorized = s.isAuthorized;
      this.emit({ kind: "capabilitiesChanged" });
    }
    if (s.state === "stopped") return;
    this.emit({ kind: "position", positionMs: s.positionMs, atMs: Date.now(), generationId });
    this.emit({
      kind: "state",
      status: s.state === "playing" ? "playing" : s.state === "buffering" ? "buffering" : "paused",
      generationId,
    });
  }
}
