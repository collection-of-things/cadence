import type {
  PlaybackSnapshot,
  QueueState,
  RemoteCommand,
  RemoteServerMessage,
} from '@cadence/protocol';
import { findReachable } from './desktopApi';
import type { SavedHost } from './savedHost';

export type Connection = 'connecting' | 'online' | 'offline' | 'revoked';

export interface LinkState {
  readonly connection: Connection;
  /** http://ip:port of the address that answered, once one did. */
  readonly base: string | null;
  readonly snapshot: PlaybackSnapshot | null;
  readonly queue: QueueState | null;
  /** Phone clock when `snapshot.positionMs` was last reported. */
  readonly positionReceivedAt: number;
  readonly lastError: string | null;
}

const INITIAL: LinkState = {
  connection: 'connecting',
  base: null,
  snapshot: null,
  queue: null,
  positionReceivedAt: 0,
  lastError: null,
};

const BACKOFF_MS = [1000, 2000, 4000, 8000, 10000];

/** Where the desktop is in the current track right now, by the phone's clock. */
export function projectedPositionMs(s: LinkState, now = Date.now()): number {
  const snap = s.snapshot;
  if (snap === null) return 0;
  const elapsed = snap.status === 'playing' ? now - s.positionReceivedAt : 0;
  const pos = snap.positionMs + Math.max(0, elapsed);
  return snap.durationMs > 0 ? Math.min(pos, snap.durationMs) : pos;
}

function isServerMessage(u: unknown): u is RemoteServerMessage {
  if (typeof u !== 'object' || u === null) return false;
  const k = (u as Record<string, unknown>).kind;
  return k === 'hello' || k === 'event' || k === 'error' || k === 'session' || k === 'control' || k === 'handoff';
}

/**
 * The live connection to the paired computer: finds a working address,
 * keeps a WebSocket open, mirrors the desktop's snapshot and queue, and
 * reconnects with backoff when Wi-Fi drops.
 */
export class DesktopLink {
  private state: LinkState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closed = false;

  constructor(
    private host: SavedHost,
    private readonly onHostChanged: (host: SavedHost) => void,
  ) {}

  getState = (): LinkState => this.state;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  get token(): string {
    return this.host.token;
  }

  start(): void {
    this.closed = false;
    void this.connect();
  }

  /** Reconnect now instead of waiting out the backoff (app came to the foreground). */
  poke(): void {
    if (this.closed || this.state.connection === 'online' || this.state.connection === 'revoked') return;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    this.attempt = 0;
    void this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    this.ws?.close();
    this.ws = null;
  }

  send(command: RemoteCommand): boolean {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ kind: 'command', command }));
    return true;
  }

  private set(patch: Partial<LinkState>): void {
    this.state = { ...this.state, ...patch };
    for (const cb of this.listeners) cb();
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    this.set({ connection: 'connecting' });
    const found = await findReachable(this.host.hosts, this.host.port, this.host.hostId);
    if (this.closed) return;
    if (found === null) {
      this.set({ connection: 'offline', lastError: `Cannot find ${this.host.name} on this network.` });
      this.scheduleRetry();
      return;
    }
    // Remember the address that answered first so the next launch tries it first.
    if (this.host.hosts[0] !== found.host) {
      this.host = { ...this.host, hosts: [found.host, ...this.host.hosts.filter((h) => h !== found.host)] };
      this.onHostChanged(this.host);
    }
    // A 401 here means the computer removed this phone; a 404 means the token is good.
    const probe = await fetch(`${found.base}/v1/media/probe?t=${encodeURIComponent(this.host.token)}`, {
      method: 'HEAD',
    }).catch(() => null);
    if (this.closed) return;
    if (probe?.status === 401) {
      this.set({ connection: 'revoked', lastError: 'This phone was removed on the computer. Pair again.' });
      return;
    }
    this.set({ base: found.base });
    const ws = new WebSocket(
      `${found.base.replace(/^http/, 'ws')}/v1/live?t=${encodeURIComponent(this.host.token)}`,
    );
    this.ws = ws;
    ws.onmessage = (ev) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (isServerMessage(msg)) this.onMessage(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed) return;
      if (ev.code === 4001) {
        this.set({ connection: 'revoked', lastError: 'This phone was removed on the computer. Pair again.' });
        return;
      }
      this.set({ connection: 'offline' });
      this.scheduleRetry();
    };
    ws.onerror = () => {
      // onclose follows and schedules the retry.
    };
  }

  private onMessage(msg: RemoteServerMessage): void {
    switch (msg.kind) {
      case 'hello':
        this.attempt = 0;
        this.set({
          connection: 'online',
          snapshot: msg.snapshot,
          queue: msg.queue,
          positionReceivedAt: Date.now(),
          lastError: null,
        });
        return;
      case 'error':
        this.set({ lastError: msg.message });
        return;
      case 'event': {
        const e = msg.event;
        switch (e.kind) {
          case 'snapshot':
            this.set({ snapshot: e.snapshot, positionReceivedAt: Date.now() });
            return;
          case 'queue':
            this.set({ queue: e.queue });
            return;
          case 'position':
            if (this.state.snapshot !== null) {
              this.set({
                snapshot: { ...this.state.snapshot, positionMs: e.positionMs },
                positionReceivedAt: Date.now(),
              });
            }
            return;
          case 'error':
            this.set({ lastError: e.message });
            return;
          case 'capabilities':
          case 'trackEnded':
          case 'output':
            return;
          default: {
            const _exhaustive: never = e;
            return _exhaustive;
          }
        }
      }
      case 'session':
      case 'control':
      case 'handoff':
        // Playback ownership (phone reports, desktop-driven control and
        // handoff) is handled on the desktop side; the phone does not act
        // on these yet.
        return;
      default: {
        const _exhaustive: never = msg;
        return _exhaustive;
      }
    }
  }

  private scheduleRetry(): void {
    if (this.closed || this.retry !== null) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)] ?? 10000;
    this.attempt += 1;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, delay);
  }
}
