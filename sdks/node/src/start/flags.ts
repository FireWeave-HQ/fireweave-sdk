/**
 * The flags object: every control point the app reads, with the value served
 * in local mode. It lives in its own file (src/fireweave/flags.ts by default)
 * and is passed as start({ flags }).
 *
 * It holds local values only. In remote mode fw-server and the rollout decide,
 * and call sites keep `false` as their default (RAMP-1), so a flags file can
 * never switch a feature on in production.
 */
import { FireweaveError, validateControlPointKey } from '../index.js';

export interface FlagDefinition {
  /** Value served in local mode. Ignored in remote mode. */
  readonly local: boolean;
  /** Optional note for humans and agents. Never sent anywhere. */
  readonly description?: string;
}

export type FlagMap = Readonly<Record<string, FlagDefinition>>;

const configError = (message: string): FireweaveError => new FireweaveError('Configuration', { message });

/** Validate a flags object and return a frozen copy. Throws Configuration on a bad entry. */
export function normalizeFlags(flags: unknown): FlagMap {
  if (flags === undefined || flags === null) return Object.freeze({});
  if (typeof flags !== 'object' || Array.isArray(flags)) {
    throw configError('[fireweave] start({ flags }) must be an object of { key: { local: boolean } }.');
  }
  const out: Record<string, FlagDefinition> = {};
  for (const [key, entry] of Object.entries(flags as Record<string, unknown>)) {
    const keyResult = validateControlPointKey(key);
    if (!keyResult.ok) throw configError(`[fireweave] flags: '${key}' is not a valid control point key.`);
    if (typeof entry !== 'object' || entry === null || typeof (entry as { local?: unknown }).local !== 'boolean') {
      throw configError(`[fireweave] flags['${key}'] must be { local: true } or { local: false }.`);
    }
    const { local, description } = entry as { local: boolean; description?: unknown };
    if (description !== undefined && typeof description !== 'string') {
      throw configError(`[fireweave] flags['${key}'].description must be a string.`);
    }
    out[key] = Object.freeze(description === undefined ? { local } : { local, description });
  }
  return Object.freeze(out);
}

/**
 * Declare the app's control points. Returns its argument unchanged, typed, and
 * checks it at import time so a typo fails where it was made.
 *
 *   export const flags = defineFlags({
 *     'new-checkout': { local: true },
 *   });
 */
export function defineFlags<const T extends Record<string, FlagDefinition>>(flags: T): T {
  normalizeFlags(flags);
  return flags;
}

/** The core local adapter's seed map. */
export function toLocalControlPoints(flags: FlagMap): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(flags)) out[key] = entry.local;
  return out;
}
