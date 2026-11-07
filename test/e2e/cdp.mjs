/**
 * Minimal Chrome DevTools Protocol client for e2e driving.
 * Talks to the app's `--remote-debugging-port` endpoint: lists targets,
 * attaches to a page, evaluates JS, queries the DOM.
 */

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ws lives on @cadence/desktop (it's the package that owns this harness).
const require = createRequire(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/desktop/package.json'),
);
const { WebSocket } = require('ws');

export class CdpClient {
  constructor(port) {
    this.port = port;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
  }

  /** Wait until the debug endpoint is up, then return the target list. */
  async targets(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/json/list`);
        if (res.ok) return await res.json();
        lastErr = new Error(`CDP http ${res.status}`);
      } catch (e) {
        lastErr = e;
      }
      await sleep(400);
    }
    throw lastErr ?? new Error('CDP endpoint never came up');
  }

  /** Find a page target by url predicate. */
  async findTarget(match, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const list = await this.targets(5_000).catch(() => []);
      const hit = list.find((t) => t.type === 'page' && match(t.url));
      if (hit) return hit;
      await sleep(500);
    }
    throw new Error('no matching CDP target');
  }

  async attach(target) {
    this.ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
    this.ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(`${msg.error.message} (${msg.error.code})`));
        else res(msg.result);
        return;
      }
      if (msg.method) this.events.push(msg);
    });
  }

  send(method, params = {}, timeoutMs = 15_000) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) rej(new Error(`${method} timed out`));
      }, timeoutMs);
    });
  }

  /**
   * Evaluate an expression in the page. `returnByValue` is always on — results
   * must be JSON-serializable. Awaited when it resolves a Promise.
   */
  async eval(expression, timeoutMs = 20_000) {
    const result = await this.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      timeoutMs,
    );
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      const desc = d.exception?.description ?? d.text ?? 'evaluation failed';
      throw new Error(desc.split('\n')[0]);
    }
    return result.result?.value;
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll `fn` until it returns a truthy value or the deadline passes. */
export async function until(fn, { timeout = 15_000, interval = 500, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}${last ? ` (last: ${last})` : ''}`);
}
