/**
 * Browser identity for the start profile: the anonymous device id, the signed-in
 * key, and how (or whether) they persist.
 *
 * The device id key and its dev_ prefix are the scaffolded harness's, so an app
 * that migrates keeps every returning visitor in the same ramp bucket. Every
 * storage access is guarded: storage that throws (privacy modes, sandboxed
 * iframes) means one id per page load, never an error.
 */
import { STORAGE_KEYS } from './names.js';

export type Persistence = 'localStorage' | 'memory';

export interface Identity {
  /** The anonymous key. */
  deviceId: string;
  /** True when the id outlives this page (stored, or supplied by the app). Only durable ids are registered. */
  durable: boolean;
  /** The signed-in key restored from storage, if any. */
  user?: string;
}

const storage = (): Storage | undefined => {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
};

export function readItem(name: string): string | undefined {
  try {
    const value = storage()?.getItem(name);
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeItem(name: string, value: string): boolean {
  try {
    const s = storage();
    if (s === undefined) return false;
    s.setItem(name, value);
    return true;
  } catch {
    return false;
  }
}

export function removeItem(name: string): void {
  try {
    storage()?.removeItem(name);
  } catch {
    // nothing to clean up if storage is unavailable
  }
}

export function mintDeviceId(): string {
  try {
    return `dev_${globalThis.crypto.randomUUID()}`;
  } catch {
    // randomUUID needs a secure context; the fallback is per page and never stored as stronger than it is.
    return `dev_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }
}

/** Load (or mint) the identity a start boots under. Writes nothing in memory mode. */
export function loadIdentity(persistence: Persistence, deviceIdOption: string | undefined): Identity {
  const user = persistence === 'localStorage' ? readItem(STORAGE_KEYS.identity) : undefined;
  const withUser = (identity: Identity): Identity => (user !== undefined ? { ...identity, user } : identity);
  if (deviceIdOption !== undefined) return withUser({ deviceId: deviceIdOption, durable: true });
  if (persistence === 'memory') return { deviceId: mintDeviceId(), durable: false };
  const stored = readItem(STORAGE_KEYS.deviceId);
  if (stored !== undefined) return withUser({ deviceId: stored, durable: true });
  const deviceId = mintDeviceId();
  return withUser({ deviceId, durable: writeItem(STORAGE_KEYS.deviceId, deviceId) });
}

/** Write the current ids (consent given). Returns whether the device id is now durable. */
export function persistIdentity(identity: Identity, user: string | undefined, appSuppliedDeviceId: boolean): boolean {
  if (user !== undefined) writeItem(STORAGE_KEYS.identity, user);
  if (appSuppliedDeviceId) return true;
  return writeItem(STORAGE_KEYS.deviceId, identity.deviceId);
}

/** Remove everything the start profile stores (consent withdrawn). */
export function clearStoredIdentity(): void {
  removeItem(STORAGE_KEYS.deviceId);
  removeItem(STORAGE_KEYS.identity);
  removeItem(STORAGE_KEYS.deviceRegistered);
}
