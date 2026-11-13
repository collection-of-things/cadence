/** What a desktop pairing QR code (cadence://pair?...) carries. */
export interface PairTarget {
  readonly hosts: string[];
  readonly port: number;
  readonly code: string;
  readonly name: string;
}

const CODE = /^\d{6}$/;

function parsePort(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const port = Number(raw);
  return port > 0 && port < 65536 ? port : null;
}

/** Parse the link a desktop pairing QR encodes. Null for anything else. */
export function parsePairLink(text: string): PairTarget | null {
  const m = /^cadence:\/\/pair\?(.*)$/.exec(text.trim());
  if (m === null) return null;
  const q = new URLSearchParams(m[1] ?? '');
  const hosts = (q.get('h') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  const port = parsePort(q.get('p'));
  const code = q.get('c') ?? '';
  if (hosts.length === 0 || port === null || !CODE.test(code)) return null;
  return { hosts, port, code, name: q.get('n') ?? 'Computer' };
}

/**
 * Parse a typed address ("192.168.1.20" or "192.168.1.20:47820") and code.
 * The port defaults to the desktop's default.
 */
export function parseManualTarget(address: string, code: string, defaultPort: number): PairTarget | null {
  const a = address.trim();
  const m = /^([^\s:/]+)(?::(\d+))?$/.exec(a);
  if (m === null || m[1] === undefined) return null;
  const port = m[2] === undefined ? defaultPort : parsePort(m[2]);
  const digits = code.replace(/\s+/g, '');
  if (port === null || !CODE.test(digits)) return null;
  return { hosts: [m[1]], port, code: digits, name: m[1] };
}
