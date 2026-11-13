import * as SecureStore from 'expo-secure-store';

/** The paired computer. The token sits in the platform keychain. */
export interface SavedHost {
  readonly hostId: string;
  readonly name: string;
  readonly hosts: string[];
  readonly port: number;
  readonly token: string;
  readonly deviceId: string;
}

const KEY = 'cadence.pairedHost';

function isSavedHost(u: unknown): u is SavedHost {
  if (typeof u !== 'object' || u === null) return false;
  const o = u as Record<string, unknown>;
  return (
    typeof o.hostId === 'string' &&
    typeof o.name === 'string' &&
    Array.isArray(o.hosts) &&
    o.hosts.every((h) => typeof h === 'string') &&
    typeof o.port === 'number' &&
    typeof o.token === 'string' &&
    typeof o.deviceId === 'string'
  );
}

export async function loadHost(): Promise<SavedHost | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isSavedHost(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveHost(host: SavedHost): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(host));
}

export async function forgetHost(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
