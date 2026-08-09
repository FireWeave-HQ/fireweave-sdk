/**
 * Evaluation-context normalization.
 *
 * A browser context is smaller than a server one — there is one user per page,
 * not one per request — but the same two rules apply, and for the same reasons:
 * reserved keys cannot be spoofed by the caller, and oversized attributes are
 * rejected rather than silently truncated by the backend.
 *
 * UTF-8 byte length is measured with `TextEncoder`, never `Buffer` — the same
 * choice ADR-0008 made in the server SDK, here because `Buffer` does not exist
 * in a browser at all.
 */
import { FireweaveError } from './errors.js';
import type { CanonicalContext, JsonValue } from './types.js';

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

export type ContextInput = Record<string, unknown> & { targetingKey?: string };

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

function depthOf(value: unknown, depth = 0): number {
  if (value === null || typeof value !== 'object') return depth;
  let deepest = depth;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepest = Math.max(deepest, depthOf(child, depth + 1));
  }
  return deepest;
}

/** Later contexts win, key by key. Mirrors the OpenFeature merge order. */
export function mergeContexts(...contexts: ReadonlyArray<ContextInput | undefined>): ContextInput {
  const merged: ContextInput = {};
  for (const ctx of contexts) {
    if (ctx === undefined) continue;
    Object.assign(merged, ctx);
  }
  return merged;
}

/**
 * Validate and canonicalize. Throws `FireweaveError('InvalidContext')` on any
 * limit breach or reserved-key use; never mutates the input.
 */
export function canonicalizeContext(
  input: ContextInput | undefined,
  limits: ContextLimits = DEFAULT_CONTEXT_LIMITS,
  reservedKeys: readonly string[] = DEFAULT_RESERVED_ATTRIBUTE_KEYS
): CanonicalContext {
  const source = input ?? {};
  const attributes: Record<string, JsonValue> = {};
  let groups: Record<string, string> | undefined;
  let groupProperties: Record<string, Record<string, JsonValue>> | undefined;
  let targetingKey: string | undefined;

  for (const [key, value] of Object.entries(source)) {
    if (key === 'targetingKey') {
      if (typeof value === 'string' && value.length > 0) targetingKey = value;
      continue;
    }
    if (reservedKeys.includes(key)) {
      throw new FireweaveError('InvalidContext');
    }
    if (key === 'groups' || key === 'fireweave.groups') {
      groups = value as Record<string, string>;
      continue;
    }
    if (key === 'groupProperties' || key === 'fireweave.groupProperties') {
      groupProperties = value as Record<string, Record<string, JsonValue>>;
      continue;
    }
    if (value === undefined) continue;
    if (byteLength(key) > limits.maxKeyBytes) throw new FireweaveError('InvalidContext');
    const serialized = JSON.stringify(value) ?? 'null';
    if (byteLength(serialized) > limits.maxValueBytes) throw new FireweaveError('InvalidContext');
    if (depthOf(value) > limits.maxNestingDepth) throw new FireweaveError('InvalidContext');
    attributes[key] = value as JsonValue;
  }

  if (Object.keys(attributes).length > limits.maxAttributeCount) {
    throw new FireweaveError('InvalidContext');
  }
  if (byteLength(JSON.stringify(attributes)) > limits.maxSerializedBytes) {
    throw new FireweaveError('InvalidContext');
  }

  const canonical: CanonicalContext = { attributes };
  return {
    ...canonical,
    ...(targetingKey !== undefined ? { targetingKey } : {}),
    ...(groups !== undefined ? { groups } : {}),
    ...(groupProperties !== undefined ? { groupProperties } : {}),
  };
}
