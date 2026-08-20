/**
 * Evaluation-context handling: merge order (global → client → invocation)
 * and normalization of raw caller input into the shape validation.ts checks,
 * plus the post-canonicalization reporting view.
 * Bounds per spec/evaluation-context.schema.json (ratified 2026-07-27):
 * 128 attrs / 256 B keys / 4 KiB values / depth 6 / 64 KiB serialized.
 *
 * Bound/reserved-key ENFORCEMENT (the pure, Validated<T>-returning checks)
 * lives in validation.ts (`validateContext`) — spec/control-points.md
 * "Validation, before any I/O" rule 3. This module has no throwing/failing
 * surface of its own.
 */
import type { CanonicalContext, JsonValue } from './types.js';

export interface ContextLimits {
  maxAttributeCount: number;
  maxKeyBytes: number;
  maxValueBytes: number;
  maxNestingDepth: number;
  maxSerializedContextBytes: number;
}

export const DEFAULT_CONTEXT_LIMITS: Readonly<ContextLimits> = Object.freeze({
  maxAttributeCount: 128,
  maxKeyBytes: 256,
  maxValueBytes: 4096,
  maxNestingDepth: 6,
  maxSerializedContextBytes: 65536,
});

/** Attribute keys callers may never set (in addition to the fireweave.* namespace). */
export const DEFAULT_RESERVED_ATTRIBUTE_KEYS: readonly string[] = Object.freeze([
  'targetingKey',
  'kind',
]);

/**
 * Sanctioned fireweave.* carriers (orchestrator rulings 12–14): the ONLY
 * `fireweave.*` context keys callers may set. They are the canonical spelling
 * for group memberships / group properties; plain `groups`/`groupProperties`
 * remain accepted as a documented alias.
 */
export const ALLOWED_FIREWEAVE_CONTEXT_KEYS: readonly string[] = Object.freeze([
  'fireweave.groups',
  'fireweave.groupProperties',
]);

export interface ContextPolicy {
  limits: ContextLimits;
  reservedAttributeKeys: readonly string[];
  requireTargetingKey: boolean;
}

/** Loose input shape accepted from callers (OpenFeature EvaluationContext-compatible). */
export interface ContextInput {
  targetingKey?: string;
  attributes?: Record<string, unknown>;
  /** OpenFeature flat contexts: extra top-level keys are treated as attributes. */
  [key: string]: unknown;
}

/**
 * Extract {targetingKey, attributes} from a caller context. Supports both the
 * canonical shape ({targetingKey, attributes:{...}}) and OpenFeature flat shape
 * ({targetingKey, plan:"pro", ...}).
 */
export function normalizeContextInput(input: ContextInput | undefined): {
  targetingKey?: string;
  attributes: Record<string, unknown>;
} {
  if (input === undefined || input === null) return { attributes: {} };
  const attributes: Record<string, unknown> = {};
  let targetingKey: string | undefined;
  if (typeof input.targetingKey === 'string' && input.targetingKey.length > 0) {
    targetingKey = input.targetingKey;
  }
  if (input.attributes !== undefined && typeof input.attributes === 'object' && input.attributes !== null && !Array.isArray(input.attributes)) {
    for (const [k, v] of Object.entries(input.attributes)) {
      if (v !== undefined) attributes[k] = v;
    }
  }
  for (const [k, v] of Object.entries(input)) {
    if (k === 'targetingKey' || k === 'attributes') continue;
    if (v !== undefined) attributes[k] = v;
  }
  return targetingKey !== undefined ? { targetingKey, attributes } : { attributes };
}

/**
 * Merge context layers with later layers winning at the attribute-key level.
 * Layers are raw inputs; output is a deep copy (caller objects never retained).
 */
export function mergeContexts(...layers: Array<ContextInput | undefined>): {
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

/**
 * Resolved context for reporting/telemetry: `$`-prefixed system directives are
 * filtered out; empty attributes omitted.
 */
export function resolvedContextView(ctx: CanonicalContext): {
  targetingKey?: string;
  attributes?: Record<string, JsonValue>;
} {
  const attributes: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(ctx.attributes)) {
    if (k.startsWith('$')) continue;
    attributes[k] = v;
  }
  const out: { targetingKey?: string; attributes?: Record<string, JsonValue> } = {};
  if (ctx.targetingKey !== undefined) out.targetingKey = ctx.targetingKey;
  if (Object.keys(attributes).length > 0) out.attributes = attributes;
  return out;
}
