import type { RemoteHostInfo, RemotePairResponse } from '@cadence/protocol';

const INFO_TIMEOUT_MS = 2500;

/** Matches REMOTE_DEFAULT_PORT in @cadence/protocol (types only cross into this app). */
export const DEFAULT_PORT = 47820;

export function baseUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isHostInfo(u: unknown): u is RemoteHostInfo {
  if (typeof u !== 'object' || u === null) return false;
  const o = u as Record<string, unknown>;
  return o.app === 'cadence' && typeof o.hostId === 'string' && typeof o.name === 'string' && typeof o.protocol === 'number';
}

function isPairResponse(u: unknown): u is RemotePairResponse {
  if (typeof u !== 'object' || u === null) return false;
  const o = u as Record<string, unknown>;
  return typeof o.token === 'string' && typeof o.deviceId === 'string' && isHostInfo(o.host);
}

/** Ask one address who it is. Null when nothing answers or it is not Cadence. */
export async function fetchInfo(base: string): Promise<RemoteHostInfo | null> {
  try {
    const res = await fetchWithTimeout(`${base}/v1/info`, {}, INFO_TIMEOUT_MS);
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isHostInfo(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * Try every address the desktop advertised at once and keep the first that
 * answers as Cadence. `hostId`, when given, must match so a different
 * computer that took over the IP is never used.
 */
export async function findReachable(
  hosts: readonly string[],
  port: number,
  hostId?: string,
): Promise<{ base: string; host: string; info: RemoteHostInfo } | null> {
  const attempts = hosts.map(async (host) => {
    const base = baseUrl(host, port);
    const info = await fetchInfo(base);
    if (info === null || (hostId !== undefined && info.hostId !== hostId)) throw new Error('no');
    return { base, host, info };
  });
  try {
    return await Promise.any(attempts);
  } catch {
    return null;
  }
}

export class PairError extends Error {}

/** Exchange the six-digit code for a token. */
export async function pair(base: string, code: string, deviceName: string): Promise<RemotePairResponse> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${base}/v1/pair`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, deviceName }),
      },
      8000,
    );
  } catch {
    throw new PairError('Could not reach the computer. Check that both are on the same Wi-Fi.');
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>).error === 'string'
        ? String((body as Record<string, unknown>).error)
        : `Pairing failed (${res.status}).`;
    throw new PairError(msg);
  }
  if (!isPairResponse(body)) throw new PairError('The computer sent an unexpected reply.');
  return body;
}
