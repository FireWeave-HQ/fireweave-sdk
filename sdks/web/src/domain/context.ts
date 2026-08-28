/**
 * Evaluation-context merge & normalization — pure, no validation.
 *
 * Bound/reserved-key ENFORCEMENT (the Validated<T>-returning checks) lives in
 * validation.ts (`validateContext`) — spec/control-points.md "Validation,
 * before any I/O" rule 3. This module has no throwing/failing surface of its
 * own, mirroring the split sdks/node/src/domain/{context,validation}.ts
 * makes.
 *
 * A browser context is smaller than a server one — there is one user per
 * page, not one per request — but the same shape applies: `targetingKey` plus
 * a flat bag of attributes, later layers winning key by key (the OpenFeature
 * merge order).
 */

export interface ContextLimits {
  readonly maxAttributeCount: number;
  readonly maxKeyBytes: number;
  readonly maxValueBytes: number;
  readonly maxSerializedBytes: number;
  readonly maxNestingDepth: number;
}

export const DEFAULT_CONTEXT_LIMITS: ContextLimits = Object.freeze({
  maxAttributeCount: 100,
  maxKeyBytes: 256,
  maxValueBytes: 8_192,
  maxSerializedBytes: 32_768,
  maxNestingDepth: 8,
});

/**
 * Keys the backend owns. A client that could set these could claim another
 * tenant's identity, so they are rejected rather than dropped — silently
 * discarding them would leave the caller believing targeting was applied.
 */
export const DEFAULT_RESERVED_ATTRIBUTE_KEYS: readonly string[] = Object.freeze([
  'fireweave.orgId',
  'fireweave.projectId',
  'fireweave.tenant',
]);

export interface ContextPolicy {
  readonly limits: ContextLimits;
  readonly reservedAttributeKeys: readonly string[];
  readonly requireTargetingKey: boolean;
}

export type ContextInput = Record<string, unknown> & { targetingKey?: string };

/** One raw layer → {targetingKey?, attributes}. No validation, no copying beyond Object.entries. */
export function normalizeContextInput(input: ContextInput | undefined): {
  targetingKey?: string;
  attributes: Record<string, unknown>;
} {
  if (input === undefined || input === null) return { attributes: {} };
  const attributes: Record<string, unknown> = {};
  let targetingKey: string | undefined;
  for (const [key, value] of Object.entries(input)) {
    if (key === 'targetingKey') {
      if (typeof value === 'string' && value.length > 0) targetingKey = value;
      continue;
    }
    if (value !== undefined) attributes[key] = value;
  }
  return targetingKey !== undefined ? { targetingKey, attributes } : { attributes };
}

/**
 * Merge context layers with later layers winning at the attribute-key level.
 * Layers are raw inputs; output is a plain {targetingKey?, attributes} bag —
 * validation (limits, reserved keys, cycle-safety) happens downstream in
 * validation.ts's `validateContext`.
 */
export function mergeContexts(...layers: ReadonlyArray<ContextInput | undefined>): {
  targetingKey?: string;
  attributes: Record<string, unknown>;
} {
  let targetingKey: string | undefined;
  const attributes: Record<string, unknown> = {};
  for (const layer of layers) {
    const { targetingKey: tk, attributes: attrs } = normalizeContextInput(layer);
    if (tk !== undefined) targetingKey = tk;
    for (const [k, v] of Object.entries(attrs)) {
      attributes[k] = v;
    }
  }
  return targetingKey !== undefined ? { targetingKey, attributes } : { attributes };
}
