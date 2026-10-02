/**
 * The flags object: every control point the app reads, with the value served
 * in local mode. It lives in its own file (src/fireweave/flags.ts by default)
 * and is passed as start({ flags }) — the same shape as the server SDK.
 *
 * It holds local values only. In remote mode fw-server and the rollout decide,
 * and call sites keep `false` as their default (RAMP-1), so a flags file can
 * never switch a feature on for real visitors.
 */
import { validateControlPointKey } from '../index.js';

export interface FlagDefinition {
  /** Value served in local mode. Ignored in remote mode. */
  readonly local: boolean;
  /** Optional note for humans and agents. Never sent anywhere. */
  readonly description?: string;
}

export type FlagMap = Readonly<Record<string, FlagDefinition>>;

/**
 * Validate a flags object and return a frozen copy. Throws a TypeError naming
 * the bad entry: the core's FireweaveError carries fixed messages only, and a
 * typo here should say which key it was.
 */
export function normalizeFlags(flags: unknown): FlagMap {
  if (flags === undefined || flags === null) return Object.freeze({});
  if (typeof flags !== 'object' || Array.isArray(flags)) {
    throw new TypeError('[fireweave] start({ flags }) must be an object of { key: { local: boolean } }.');
  }
  const out: Record<string, FlagDefinition> = {};
  for (const [key, entry] of Object.entries(flags as Record<string, unknown>)) {
    if (!validateControlPointKey(key).ok) throw new TypeError(`[fireweave] flags: '${key}' is not a valid control point key.`);
    if (typeof entry !== 'object' || entry === null || typeof (entry as { local?: unknown }).local !== 'boolean') {
      throw new TypeError(`[fireweave] flags['${key}'] must be { local: true } or { local: false }.`);
    }
    const { local, description } = entry as { local: boolean; description?: unknown };
    if (description !== undefined && typeof description !== 'string') {
      throw new TypeError(`[fireweave] flags['${key}'].description must be a string.`);
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
