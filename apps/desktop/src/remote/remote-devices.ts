import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { REMOTE_DEFAULT_PORT, type RemotePairedDevice } from "@cadence/protocol";
import type { SettingsStore } from "../coordinator/settings-store.js";

/** How long a pairing code stays valid. */
export const PAIRING_WINDOW_MS = 5 * 60_000;
/** Wrong codes allowed before the pairing window closes. */
export const PAIRING_MAX_ATTEMPTS = 5;
const SECTION = "remote";
const MAX_NAME_LENGTH = 60;

interface StoredDevice {
  readonly id: string;
  readonly name: string;
  /** sha256 of the bearer token; the token itself is never stored. */
  readonly tokenHash: string;
  readonly pairedAtMs: number;
  readonly lastSeenAtMs: number | null;
}

interface RemoteSettings {
  readonly enabled: boolean;
  readonly port: number;
  readonly hostId: string;
  readonly devices: readonly StoredDevice[];
}

interface OpenPairing {
  readonly code: string;
  readonly expiresAtMs: number;
  attempts: number;
}

export type PairResult =
  | { kind: "paired"; token: string; device: StoredDevice }
  | { kind: "no-pairing" }
  | { kind: "wrong-code"; attemptsLeft: number };

export interface RemoteDevicesDeps {
  readonly store: SettingsStore;
  readonly now?: () => number;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isStoredDevice(u: unknown): u is StoredDevice {
  if (typeof u !== "object" || u === null) return false;
  const d = u as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    typeof d.name === "string" &&
    typeof d.tokenHash === "string" &&
    /^[0-9a-f]{64}$/.test(d.tokenHash) &&
    typeof d.pairedAtMs === "number" &&
    (d.lastSeenAtMs === null || typeof d.lastSeenAtMs === "number")
  );
}

function parseSettings(u: unknown): RemoteSettings {
  const o = typeof u === "object" && u !== null ? (u as Record<string, unknown>) : {};
  const port =
    typeof o.port === "number" && Number.isInteger(o.port) && o.port >= 0 && o.port < 65536
      ? o.port
      : REMOTE_DEFAULT_PORT;
  return {
    enabled: o.enabled === true,
    port,
    hostId: typeof o.hostId === "string" && o.hostId.length > 0 ? o.hostId : randomUUID(),
    devices: Array.isArray(o.devices) ? o.devices.filter(isStoredDevice) : [],
  };
}

/** Trim a phone-supplied name to something safe to show in the desktop UI. */
export function cleanDeviceName(raw: string): string {
  // Drop control characters; keep everything else the phone reports.
  const name = [...raw]
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c >= 0x20 && c !== 0x7f;
    })
    .join("")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return name.length > 0 ? name : "Phone";
}

/**
 * Paired devices, their tokens, and the short-lived pairing window. State
 * lives in the settings file's "remote" section; tokens are stored hashed.
 */
export class RemoteDevices {
  private settings: RemoteSettings;
  private pairing: OpenPairing | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: RemoteDevicesDeps) {
    this.now = deps.now ?? Date.now;
    this.settings = parseSettings(deps.store.loadSection(SECTION));
    // Persist a freshly minted hostId so it stays stable across launches.
    this.save();
  }

  get enabled(): boolean {
    return this.settings.enabled;
  }

  get port(): number {
    return this.settings.port;
  }

  get hostId(): string {
    return this.settings.hostId;
  }

  setEnabled(enabled: boolean): void {
    this.settings = { ...this.settings, enabled };
    if (!enabled) this.pairing = null;
    this.save();
  }

  setPort(port: number): void {
    this.settings = { ...this.settings, port };
    this.save();
  }

  /** Open (or restart) the pairing window with a fresh six-digit code. */
  openPairing(): { code: string; expiresAtMs: number } {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.pairing = { code, expiresAtMs: this.now() + PAIRING_WINDOW_MS, attempts: 0 };
    return { code, expiresAtMs: this.pairing.expiresAtMs };
  }

  closePairing(): void {
    this.pairing = null;
  }

  /** The open pairing window, or null once it has expired or closed. */
  currentPairing(): { code: string; expiresAtMs: number } | null {
    if (this.pairing === null) return null;
    if (this.now() >= this.pairing.expiresAtMs) {
      this.pairing = null;
      return null;
    }
    return { code: this.pairing.code, expiresAtMs: this.pairing.expiresAtMs };
  }

  /** Exchange a pairing code for a token. Closes the window on success or after too many misses. */
  pair(code: string, deviceName: string): PairResult {
    const open = this.currentPairing();
    if (open === null || this.pairing === null) return { kind: "no-pairing" };
    const given = Buffer.from(code.trim());
    const want = Buffer.from(open.code);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      this.pairing.attempts += 1;
      const attemptsLeft = PAIRING_MAX_ATTEMPTS - this.pairing.attempts;
      if (attemptsLeft <= 0) this.pairing = null;
      return { kind: "wrong-code", attemptsLeft: Math.max(0, attemptsLeft) };
    }
    this.pairing = null;
    const token = randomBytes(32).toString("base64url");
    const device: StoredDevice = {
      id: randomUUID(),
      name: cleanDeviceName(deviceName),
      tokenHash: hashToken(token),
      pairedAtMs: this.now(),
      lastSeenAtMs: this.now(),
    };
    this.settings = { ...this.settings, devices: [...this.settings.devices, device] };
    this.save();
    return { kind: "paired", token, device };
  }

  /** The device a bearer token belongs to, or null. */
  authenticate(token: string): StoredDevice | null {
    if (token.length === 0) return null;
    const hash = Buffer.from(hashToken(token), "hex");
    for (const d of this.settings.devices) {
      if (timingSafeEqual(hash, Buffer.from(d.tokenHash, "hex"))) return d;
    }
    return null;
  }

  /** Record that a device was just seen. */
  touch(deviceId: string): void {
    const at = this.now();
    this.settings = {
      ...this.settings,
      devices: this.settings.devices.map((d) => (d.id === deviceId ? { ...d, lastSeenAtMs: at } : d)),
    };
    this.save();
  }

  /** Forget a device; its token stops working immediately. */
  revoke(deviceId: string): boolean {
    const before = this.settings.devices.length;
    this.settings = {
      ...this.settings,
      devices: this.settings.devices.filter((d) => d.id !== deviceId),
    };
    this.save();
    return this.settings.devices.length !== before;
  }

  list(online: ReadonlySet<string>): RemotePairedDevice[] {
    return this.settings.devices.map((d) => ({
      id: d.id,
      name: d.name,
      pairedAtMs: d.pairedAtMs,
      lastSeenAtMs: d.lastSeenAtMs,
      online: online.has(d.id),
    }));
  }

  private save(): void {
    this.deps.store.saveSection(SECTION, this.settings);
  }
}
