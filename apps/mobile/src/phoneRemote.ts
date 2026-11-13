import type {
  PlaybackSnapshot,
  QueueItem,
  QueueState,
  RemoteClientMessage,
  RemotePhoneCommand,
  RemoteServerMessage,
} from '@cadence/protocol';
import { isStreamable, orderIndexOf, playOrder } from './tracks.ts';

/** How long a takeover may take to start playing before the phone gives up and leaves the computer playing. */
export const TAKEOVER_TIMEOUT_MS = 10_000;
/** Longest gap between output reports while the phone plays. */
const REPORT_INTERVAL_MS = 1000;

/** The part of DesktopLink the ownership logic uses. */
export interface OwnershipLink {
  sendMessage(msg: RemoteClientMessage): boolean;
  getState(): {
    readonly connection: 'connecting' | 'online' | 'offline' | 'revoked';
    readonly base: string | null;
    readonly queue: QueueState | null;
    readonly snapshot: PlaybackSnapshot | null;
  };
  readonly token: string;
}

/** The part of PhoneSession the ownership logic uses. */
export interface OwnershipPlayer {
  getState(): {
    readonly active: boolean;
    readonly playing: boolean;
    readonly positionMs: number;
    readonly durationMs: number;
  };
  subscribe(cb: () => void): () => void;
  start(p: {
    items: QueueItem[];
    index: number;
    positionMs: number;
    repeat: QueueState['repeat'];
    base: string;
    token: string;
  }): Promise<void>;
  current(): QueueItem | null;
  volume(): number;
  resume(): void;
  pause(): void;
  next(): void;
  previous(): void;
  seek(positionMs: number): void;
  setVolume(volume: number): void;
  playQueueId(queueId: string): boolean;
  stop(): void;
}

export type TakeOverResult = 'started' | 'unavailable' | 'unsupported' | 'busy';

/**
 * Keeps the phone and the computer agreeing on who plays. The phone claims
 * playback only once its player is really playing (the first output report
 * is what pauses the computer), reports while it holds playback, says
 * `release` when it lets go, and obeys the computer's `control`, `handoff`
 * and `session` messages.
 */
export class PhoneRemote {
  private deviceId: string | null = null;
  /** True once the computer has been told this phone owns playback. */
  private owning = false;
  private pending: { timer: ReturnType<typeof setTimeout> } | null = null;
  private lastKey = '';
  private lastReportAt = 0;
  private lastPositionMs = 0;
  private readonly unsubscribe: () => void;

  private readonly link: OwnershipLink;
  private readonly player: OwnershipPlayer;
  private readonly notify: (message: string) => void;
  private readonly now: () => number;
  private readonly takeoverTimeoutMs: number;

  constructor(
    link: OwnershipLink,
    player: OwnershipPlayer,
    notify: (message: string) => void,
    now: () => number = Date.now,
    takeoverTimeoutMs: number = TAKEOVER_TIMEOUT_MS,
  ) {
    this.link = link;
    this.player = player;
    this.notify = notify;
    this.now = now;
    this.takeoverTimeoutMs = takeoverTimeoutMs;
    this.unsubscribe = player.subscribe(() => this.onPlayerChange());
  }

  dispose(): void {
    this.unsubscribe();
    this.clearPending();
  }

  /** Move playback to the phone, at the computer's current spot unless the caller says otherwise. */
  async takeOver(at?: { queueId: string; positionMs: number }): Promise<TakeOverResult> {
    const ls = this.link.getState();
    if (ls.connection !== 'online' || ls.base === null || ls.queue === null) return 'unavailable';
    if (this.pending !== null) return 'busy';
    const items = playOrder(ls.queue);
    const queueId = at?.queueId ?? ls.snapshot?.current?.queueId;
    const index = queueId === undefined ? -1 : orderIndexOf(ls.queue, queueId);
    const item = items[index];
    if (item === undefined) return 'unavailable';
    if (!isStreamable(item.track)) return 'unsupported';
    const positionMs = at?.positionMs ?? ls.snapshot?.positionMs ?? 0;

    const timer = setTimeout(() => this.failTakeover(), this.takeoverTimeoutMs);
    this.pending = { timer };
    try {
      await this.player.start({
        items,
        index,
        positionMs,
        repeat: ls.queue.repeat,
        base: ls.base,
        token: this.link.token,
      });
    } catch (e) {
      this.failTakeover(e instanceof Error ? e.message : undefined);
      return 'unavailable';
    }
    this.onPlayerChange();
    return 'started';
  }

  handle(msg: RemoteServerMessage): void {
    switch (msg.kind) {
      case 'hello':
        this.deviceId = msg.deviceId;
        return;
      case 'session':
        this.onSession(msg.activeDeviceId);
        return;
      case 'control':
        this.onControl(msg.command);
        return;
      case 'handoff':
        void this.takeOver({ queueId: msg.queueId, positionMs: msg.positionMs }).then((r) => {
          if (r === 'unsupported') this.notify('The computer asked the phone to take over, but that song only plays in its own app.');
          else if (r === 'unavailable') this.notify('The computer asked the phone to take over, but it is not ready.');
        });
        return;
      case 'event':
      case 'error':
        return;
      default: {
        const _exhaustive: never = msg;
        return _exhaustive;
      }
    }
  }

  private onSession(activeDeviceId: string | null): void {
    const mine = this.deviceId !== null && activeDeviceId === this.deviceId;
    const state = this.player.getState();
    if (mine) return;
    if (this.pending !== null) return;
    if (state.active) {
      // The computer does not know this phone plays (it dropped off and came back).
      if (this.link.getState().snapshot?.status === 'playing') {
        this.player.stop();
        this.notify('The computer is playing, so the phone stopped.');
      } else {
        this.owning = false;
        this.report(true);
      }
    } else if (this.owning || activeDeviceId === this.deviceId) {
      this.owning = false;
      this.link.sendMessage({ kind: 'release' });
    }
  }

  private onControl(cmd: RemotePhoneCommand): void {
    const state = this.player.getState();
    if (cmd.kind === 'stop') {
      this.clearPending();
      if (state.active) this.player.stop();
      // Always acknowledge: the computer ignores reports until it hears this.
      this.owning = false;
      this.link.sendMessage({ kind: 'release' });
      return;
    }
    if (!state.active) return;
    switch (cmd.kind) {
      case 'play':
        if (!this.player.playQueueId(cmd.queueId)) this.notify('The computer asked for a song that is not in the phone queue.');
        return;
      case 'pause':
        this.player.pause();
        return;
      case 'resume':
        this.player.resume();
        return;
      case 'next':
        this.player.next();
        return;
      case 'previous':
        this.player.previous();
        return;
      case 'seek':
        this.player.seek(cmd.positionMs);
        return;
      case 'setVolume':
        this.player.setVolume(cmd.volume);
        this.report(true);
        return;
      default: {
        const _exhaustive: never = cmd;
        return _exhaustive;
      }
    }
  }

  private onPlayerChange(): void {
    const state = this.player.getState();
    if (!state.active) {
      this.clearPending();
      if (this.owning) {
        this.owning = false;
        this.link.sendMessage({ kind: 'release' });
      }
      return;
    }
    if (this.pending !== null) {
      if (!state.playing) return;
      this.clearPending();
      this.owning = true;
      this.report(true);
      return;
    }
    if (this.owning) this.report(false);
  }

  private failTakeover(reason?: string): void {
    this.clearPending();
    if (this.player.getState().active && !this.owning) this.player.stop();
    this.notify(reason ?? 'The phone could not start that song, so the computer keeps playing.');
  }

  private clearPending(): void {
    if (this.pending === null) return;
    clearTimeout(this.pending.timer);
    this.pending = null;
  }

  private report(force: boolean): void {
    const item = this.player.current();
    if (item === null) return;
    const s = this.player.getState();
    const key = `${item.queueId}|${s.playing}`;
    const at = this.now();
    const due = s.playing ? at - this.lastReportAt >= REPORT_INTERVAL_MS : s.positionMs !== this.lastPositionMs;
    if (!force && key === this.lastKey && !due) return;
    if (
      !this.link.sendMessage({
        kind: 'output',
        output: {
          queueId: item.queueId,
          playing: s.playing,
          positionMs: s.positionMs,
          durationMs: s.durationMs,
          volume: this.player.volume(),
        },
      })
    ) {
      return;
    }
    this.owning = true;
    this.lastKey = key;
    this.lastReportAt = at;
    this.lastPositionMs = s.positionMs;
  }
}
