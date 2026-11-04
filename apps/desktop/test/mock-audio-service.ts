import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { AudioChildProcess } from "../src/audio/audio-client.js";

/**
 * In-memory stand-in for the cadence-audio child process. Speaks the same
 * newline-delimited JSON-RPC: writes to stdin are parsed as requests/events,
 * responses and spontaneous events are pushed back on stdout.
 */
export class MockAudioService extends EventEmitter implements AudioChildProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly received: { id: number; method: string; params: unknown }[] = [];
  /** Method -> result|Error handler; unhandled methods get no response. */
  readonly handlers = new Map<string, (params: never) => unknown>();
  /** Method -> delay (ms) before its response is pushed. */
  readonly delays = new Map<string, number>();
  killed = false;

  constructor() {
    super();
    this.stdout = new Readable({ read: () => undefined });
    let buf = "";
    this.stdin = new Writable({
      write: (chunk: Buffer | string, _enc, cb) => {
        buf += chunk.toString();
        let idx = buf.indexOf("\n");
        while (idx >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          this.handleLine(line);
          idx = buf.indexOf("\n");
        }
        cb();
      },
    });
    this.handlers.set("audio.ping", () => ({}));
    this.handlers.set("audio.shutdown", () => ({}));
  }

  /** All JSON-RPC requests received, in order (method names). */
  methods(): string[] {
    return this.received.map((r) => r.method);
  }

  private handleLine(line: string): void {
    let msg: { id?: number; method?: string; params?: unknown };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.id !== "number" || typeof msg.method !== "string") return;
    this.received.push({ id: msg.id, method: msg.method, params: msg.params });
    const handler = this.handlers.get(msg.method);
    if (handler === undefined) return;
    const respond = (): void => {
      try {
        const result = handler(msg.params as never);
        if (result instanceof Error) {
          this.push({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: result.message } });
        } else {
          this.push({ jsonrpc: "2.0", id: msg.id, result: result ?? {} });
        }
      } catch (e) {
        this.push({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: e instanceof Error ? e.message : String(e) },
        });
      }
    };
    const delay = this.delays.get(msg.method) ?? 0;
    if (delay > 0) setTimeout(respond, delay);
    else respond();
  }

  /** Push one outbound line (response or event). */
  push(obj: unknown): void {
    this.stdout.push(`${JSON.stringify(obj)}\n`);
  }

  /** Emit an event.* notification on stdout. */
  pushEvent(method: string, params: unknown): void {
    this.push({ jsonrpc: "2.0", method, params });
  }

  /** Simulate process termination; triggers the 'exit' event async. */
  kill(): void {
    if (this.killed) return;
    this.killed = true;
    queueMicrotask(() => {
      this.emit("exit", 1, null);
    });
  }

  /** Simulate a crash (same as kill — exits are indistinguishable here). */
  crash(): void {
    this.kill();
  }
}

/** Spawn factory that hands out a fresh MockAudioService per spawn. */
export function mockSpawnFactory(): {
  spawn: () => MockAudioService;
  services: MockAudioService[];
} {
  const services: MockAudioService[] = [];
  return {
    services,
    spawn: () => {
      const s = new MockAudioService();
      services.push(s);
      return s;
    },
  };
}
