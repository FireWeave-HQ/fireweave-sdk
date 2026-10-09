/**
 * The control-points object: every control point the app reads, with the value
 * served in local mode. It lives in its own file
 * (src/fireweave/control-points.ts by default) and is passed as
 * start({ controlPoints }) — the same shape as the server SDK.
 *
 * It holds local values only. In remote mode fw-server and the rollout decide,
 * and call sites keep `false` as their default (RAMP-1), so this file can
 * never switch a feature on for real visitors.
 */
import { validateControlPointKey } from '../index.js';

export interface ControlPointDefinition {
  /** Value served in local mode. Ignored in remote mode. */
  readonly local: boolean;
  /** Optional note for humans and agents. Never sent anywhere. */
  readonly description?: string;
}

export type ControlPointMap = Readonly<Record<string, ControlPointDefinition>>;

/**
 * Validate a control-points object and return a frozen copy. Throws a TypeError naming
 * the bad entry: the core's FireweaveError carries fixed messages only, and a
 * typo here should say which key it was.
 */
export function normalizeControlPoints(controlPoints: unknown): ControlPointMap {
  if (controlPoints === undefined || controlPoints === null) return Object.freeze({});
  if (typeof controlPoints !== 'object' || Array.isArray(controlPoints)) {
    throw new TypeError('[fireweave] start({ controlPoints }) must be an object of { key: { local: boolean } }.');
  }
  const out: Record<string, ControlPointDefinition> = {};
  for (const [key, entry] of Object.entries(controlPoints as Record<string, unknown>)) {
    if (!validateControlPointKey(key).ok) throw new TypeError(`[fireweave] controlPoints: '${key}' is not a valid control point key.`);
    if (typeof entry !== 'object' || entry === null || typeof (entry as { local?: unknown }).local !== 'boolean') {
      throw new TypeError(`[fireweave] controlPoints['${key}'] must be { local: true } or { local: false }.`);
    }
    const { local, description } = entry as { local: boolean; description?: unknown };
    if (description !== undefined && typeof description !== 'string') {
      throw new TypeError(`[fireweave] controlPoints['${key}'].description must be a string.`);
    }
    out[key] = Object.freeze(description === undefined ? { local } : { local, description });
  }
  return Object.freeze(out);
}

/**
 * Declare the app's control points. Returns its argument unchanged, typed, and
 * checks it at import time so a typo fails where it was made.
 *
 *   export const controlPoints = defineControlPoints({
 *     'new-checkout': { local: true },
 *   });
 */
export function defineControlPoints<const T extends Record<string, ControlPointDefinition>>(controlPoints: T): T {
  normalizeControlPoints(controlPoints);
  return controlPoints;
}

/** The core local adapter's seed map. */
export function toLocalControlPoints(controlPoints: ControlPointMap): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(controlPoints)) out[key] = entry.local;
  return out;
}
