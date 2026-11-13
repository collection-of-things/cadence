import { createAudioPlayer, setAudioModeAsync, type AudioPlayer, type AudioStatus } from 'expo-audio';
import type { QueueItem, QueueState } from '@cadence/protocol';
import { artistLine, artworkUri, isStreamable, mediaUri } from './tracks';

export interface PhoneState {
  /** True while this phone owns playback. */
  readonly active: boolean;
  readonly items: QueueItem[];
  readonly index: number;
  readonly playing: boolean;
  readonly buffering: boolean;
  readonly positionMs: number;
  readonly durationMs: number;
  /** Set when the queue reached a streaming-service track the phone cannot play itself. */
  readonly stoppedAt: QueueItem | null;
  readonly error: string | null;
}

const IDLE: PhoneState = {
  active: false,
  items: [],
  index: -1,
  playing: false,
  buffering: false,
  positionMs: 0,
  durationMs: 0,
  stoppedAt: null,
  error: null,
};

/** How far into a track "previous" restarts it instead of going back. */
const RESTART_THRESHOLD_MS = 3000;

/**
 * Plays the computer's queue on the phone, streaming local files from the
 * desktop over the LAN. Owns one expo-audio player for the session.
 */
export class PhoneSession {
  private state: PhoneState = IDLE;
  private readonly listeners = new Set<() => void>();
  private player: AudioPlayer | null = null;
  private repeat: QueueState['repeat'] = 'off';
  private base = '';
  private token = '';
  private modeReady = false;
  /** Seek to apply once the new source has loaded; seeking earlier is dropped on some players. */
  private pendingSeekMs: number | null = null;

  getState = (): PhoneState => this.state;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  /** Take over playback at `index` of `items`, starting `positionMs` in. */
  async start(p: {
    items: QueueItem[];
    index: number;
    positionMs: number;
    repeat: QueueState['repeat'];
    base: string;
    token: string;
  }): Promise<void> {
    this.repeat = p.repeat;
    this.base = p.base;
    this.token = p.token;
    await this.ensureAudioMode();
    this.set({ ...IDLE, active: true, items: p.items });
    this.load(p.index, p.positionMs, true);
  }

  toggle(): void {
    const player = this.player;
    if (player === null || !this.state.active) return;
    if (player.playing) player.pause();
    else player.play();
  }

  pause(): void {
    this.player?.pause();
  }

  resume(): void {
    if (this.state.active) this.player?.play();
  }

  /** The player's own volume, 0..1. */
  volume(): number {
    return this.player?.volume ?? 1;
  }

  setVolume(volume: number): void {
    if (this.player !== null) this.player.volume = Math.min(1, Math.max(0, volume));
  }

  /** Jump to a queue item by desktop queue id. False when the phone's copy of the queue lacks it. */
  playQueueId(queueId: string): boolean {
    const i = this.state.items.findIndex((it) => it.queueId === queueId);
    if (i < 0) return false;
    this.load(i, 0, true);
    return true;
  }

  next(): void {
    const n = this.state.index + 1;
    if (n < this.state.items.length) this.load(n, 0, true);
    else if (this.repeat === 'all' && this.state.items.length > 0) this.load(0, 0, true);
  }

  previous(): void {
    if (this.state.positionMs > RESTART_THRESHOLD_MS || this.state.index <= 0) {
      void this.player?.seekTo(0);
      return;
    }
    this.load(this.state.index - 1, 0, true);
  }

  jump(index: number): void {
    if (index >= 0 && index < this.state.items.length) this.load(index, 0, true);
  }

  seek(positionMs: number): void {
    void this.player?.seekTo(positionMs / 1000);
  }

  /** Stop playing on the phone and release the player. */
  stop(): void {
    if (this.player !== null) {
      this.player.clearLockScreenControls();
      this.player.remove();
      this.player = null;
    }
    this.set(IDLE);
  }

  current(): QueueItem | null {
    return this.state.items[this.state.index] ?? null;
  }

  private async ensureAudioMode(): Promise<void> {
    if (this.modeReady) return;
    await setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    });
    this.modeReady = true;
  }

  private load(index: number, positionMs: number, autoplay: boolean): void {
    const item = this.state.items[index];
    if (item === undefined) return;
    if (!isStreamable(item.track)) {
      // A streaming-service track: the phone cannot play it itself.
      this.player?.pause();
      this.set({ index, playing: false, stoppedAt: item, positionMs: 0, durationMs: item.track.durationMs });
      return;
    }
    const source = { uri: mediaUri(this.base, item.track, this.token), name: item.track.title };
    if (this.player === null) {
      this.player = createAudioPlayer(source, { updateInterval: 500 });
      this.player.addListener('playbackStatusUpdate', (s) => this.onStatus(s));
    } else {
      this.player.replace(source);
    }
    const player = this.player;
    const art = artworkUri(this.base, item.track, this.token);
    player.setActiveForLockScreen(true, {
      title: item.track.title,
      artist: artistLine(item.track),
      ...(item.track.album !== undefined ? { albumTitle: item.track.album } : {}),
      ...(art !== null ? { artworkUrl: art } : {}),
    });
    this.set({
      index,
      stoppedAt: null,
      error: null,
      positionMs,
      durationMs: item.track.durationMs,
      buffering: true,
    });
    this.pendingSeekMs = positionMs > 0 ? positionMs : null;
    if (autoplay) player.play();
  }

  private applyPendingSeek(): void {
    const ms = this.pendingSeekMs;
    if (ms === null || this.player === null) return;
    this.pendingSeekMs = null;
    void this.player.seekTo(ms / 1000);
  }

  private onStatus(s: AudioStatus): void {
    if (!this.state.active) return;
    if (s.isLoaded && this.pendingSeekMs !== null) this.applyPendingSeek();
    if (s.didJustFinish) {
      if (this.repeat === 'one') {
        void this.player?.seekTo(0).then(() => this.player?.play());
        return;
      }
      const n = this.state.index + 1;
      if (n < this.state.items.length) this.load(n, 0, true);
      else if (this.repeat === 'all' && this.state.items.length > 0) this.load(0, 0, true);
      else this.set({ playing: false });
      return;
    }
    this.set({
      playing: s.playing,
      buffering: s.isBuffering,
      positionMs: Math.round(s.currentTime * 1000),
      durationMs: s.duration > 0 ? Math.round(s.duration * 1000) : this.state.durationMs,
    });
  }

  private set(patch: Partial<PhoneState>): void {
    this.state = { ...this.state, ...patch };
    for (const cb of this.listeners) cb();
  }
}
