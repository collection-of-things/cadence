/**
 * Spotify web player route — the user-selected fallback when librespot
 * cannot get an audio key. A hidden ECS view running open.spotify.com.
 *
 * Honest status: packaged Electron DRM playback needs Castlabs EVS signing,
 * which is not set up tonight — so this route reports 'unauthenticated' or
 * 'unavailable' rather than pretending it can play.
 */

import type { PlaybackLease, QueueItem, RouteCapabilities } from "@cadence/protocol";
import { ProviderViewAdapter } from "./provider-adapter-base.js";
import { ProviderSession } from "./provider-session.js";

export class SpotifyWebAdapter extends ProviderViewAdapter {
  readonly route = "spotify-web" as const;
  private session: ProviderSession;
  private generation = 0;

  constructor() {
    super();
    this.session = new ProviderSession({
      partition: "persist:provider-spotify",
      url: "https://open.spotify.com",
      onEvent: (e) => {
        if (e.name === "viewGone") this.error("Spotify web view crashed", true);
        if (e.name === "playerState") {
          const s = e.data as { state?: string; positionMs?: number };
          const generationId = this.generation;
          if (s.positionMs != null)
            this.emit({ kind: "position", positionMs: s.positionMs, atMs: Date.now(), generationId });
          if (s.state)
            this.emit({
              kind: "state",
              status: s.state === "playing" ? "playing" : s.state === "buffering" ? "buffering" : "paused",
              generationId,
            });
        }
      },
    });
  }

  async prepare(): Promise<void> {
    await this.session.prepare();
  }

  async capabilities(): Promise<RouteCapabilities> {
    return this.baseCapabilities({
      route: this.route,
      state: "unavailable",
      stateDetail:
        "Spotify web playback in a packaged build needs Widevine via Castlabs EVS signing (not configured tonight).",
      playback: {
        engine: "provider-engine",
        canPlay: false,
        canPause: true,
        canSeek: true,
        canNextPrevious: true,
        gapless: "unknown",
        exclusiveOutput: "no",
      },
      audio: { pcmAccess: "no", eq: "no", replayGain: "no", qualityCeiling: "AAC 128/256kbps" },
      visuals: { kind: "ambient" },
      notes: [
        "Fallback for when librespot cannot obtain an audio key.",
        "Requires EVS-signed build for DRM playback; signing hooks are prepared in the package config.",
      ],
    });
  }

  async play(item: QueueItem, lease: PlaybackLease): Promise<void> {
    this.generation = lease.generationId;
    this.error("Spotify web route cannot play in an unsigned build", false, "drm-unsigned");
    throw new Error("spotify-web unavailable");
  }

  async pause(lease: PlaybackLease): Promise<void> {
    if (lease.generationId !== this.generation) return;
    await this.session
      .eval(`(document.querySelector('video')||document.querySelector('audio'))?.pause?.()`)
      .catch(() => {});
  }

  async resume(lease: PlaybackLease): Promise<void> {
    if (lease.generationId !== this.generation) return;
    await this.session
      .eval(`(document.querySelector('video')||document.querySelector('audio'))?.play?.()`)
      .catch(() => {});
  }

  async stop(lease: PlaybackLease): Promise<void> {
    return this.pause(lease);
  }

  async seek(lease: PlaybackLease, positionMs: number): Promise<void> {
    if (lease.generationId !== this.generation) return;
    await this.session
      .eval(`(()=>{const v=document.querySelector('video');if(v)v.currentTime=${positionMs / 1000}})()`)
      .catch(() => {});
  }

  async setVolume(volume: number): Promise<void> {
    await this.session
      .eval(`(()=>{const v=document.querySelector('video');if(v)v.volume=${Math.max(0, Math.min(1, volume))}})()`)
      .catch(() => {});
  }

  async signIn(): Promise<void> {
    await this.prepare();
    this.session.reveal();
  }

  async dispose(): Promise<void> {
    await this.session.dispose();
  }
}
