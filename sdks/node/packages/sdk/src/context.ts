/**
 * Evaluation-context handling: merge order (global → client → invocation),
 * immutability (deep copy), bounds enforcement, reserved-key rules.
 * Bounds per spec/evaluation-context.schema.json (ratified 2026-07-27):
 * 128 attrs / 256 B keys / 4 KiB values / depth 6 / 64 KiB serialized.
 */
import { FireweaveError } from './errors.js';
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

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

function deepCopyJson(value: unknown): JsonValue {
  // Structured clone of JSON-compatible data; drops functions/undefined like JSON round-trip.
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => deepCopyJson(v));
  }
  if (typeof value === 'object') {
    const out: { [key: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = deepCopyJson(v);
    }
    return out;
  }
  return null;
}

function nestingDepth(value: JsonValue): number {
  if (value === null || typeof value !== 'object') return 0;
  let max = 0;
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    const d = nestingDepth(child);
    if (d > max) max = d;
  }
  return max + 1;
}

const invalidContext = (message: string): FireweaveError =>
  new FireweaveError('InvalidContext', { message });

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
 * Validate and canonicalize a merged context. Throws FireweaveError(InvalidContext)
 * with the canonical bound messages; callers convert to error decisions.
 */
export function canonicalizeContext(
  merged: { targetingKey?: string; attributes: Record<string, unknown> },
  policy: ContextPolicy,
): CanonicalContext {
  const { limits } = policy;
  const attributes = deepCopyJson(merged.attributes) as Record<string, JsonValue>;

  const keys = Object.keys(attributes);
  if (keys.length > limits.maxAttributeCount) {
    throw invalidContext('context exceeds maximum attribute count');
  }
  for (const key of keys) {
    if (byteLength(key) > limits.maxKeyBytes) {
      throw invalidContext('context key exceeds maximum size');
    }
  }
  for (const key of keys) {
    const value = attributes[key];
    if (byteLength(JSON.stringify(value ?? null)) > limits.maxValueBytes) {
      throw invalidContext('context value exceeds maximum size');
    }
  }
  for (const key of keys) {
    const value = attributes[key];
    if (value !== undefined && nestingDepth(value) > limits.maxNestingDepth) {
      throw invalidContext('context exceeds maximum nesting depth');
    }
  }
  const serialized = JSON.stringify({ targetingKey: merged.targetingKey, attributes });
  if (byteLength(serialized) > limits.maxSerializedContextBytes) {
    throw invalidContext('serialized context exceeds maximum size');
  }
  for (const key of keys) {
    if (policy.reservedAttributeKeys.includes(key)) {
      throw invalidContext('invalid evaluation context');
    }
    // Ruling 13: exactly fireweave.groups + fireweave.groupProperties are
    // permitted in the reserved namespace; every other fireweave.* key is rejected.
    if (key.startsWith('fireweave.') && !ALLOWED_FIREWEAVE_CONTEXT_KEYS.includes(key)) {
      throw invalidContext('invalid evaluation context');
    }
  }
  if (policy.requireTargetingKey && (merged.targetingKey === undefined || merged.targetingKey === '')) {
    throw new FireweaveError('InvalidContext', {
      message: 'targeting key missing',
      openFeatureErrorCode: 'TARGETING_KEY_MISSING',
    });
  }

  const canonical: CanonicalContext = { attributes };
  if (merged.targetingKey !== undefined) canonical.targetingKey = merged.targetingKey;

  // Group memberships: canonical carrier `fireweave.groups` (rulings 13–14),
  // with plain `groups` retained as a documented alias.
  const groups = attributes['fireweave.groups'] ?? attributes['groups'];
  if (groups !== null && groups !== undefined && typeof groups === 'object' && !Array.isArray(groups)) {
    const g: Record<string, string> = {};
    let allStrings = true;
    for (const [k, v] of Object.entries(groups)) {
      if (typeof v === 'string') g[k] = v;
      else allStrings = false;
    }
    if (allStrings) canonical.groups = g;
  }
  // Group properties: canonical carrier `fireweave.groupProperties`,
  // plain `groupProperties` retained as alias.
  const groupProps = attributes['fireweave.groupProperties'] ?? attributes['groupProperties'];
  if (
    groupProps !== null &&
    groupProps !== undefined &&
    typeof groupProps === 'object' &&
    !Array.isArray(groupProps)
  ) {
    canonical.groupProperties = groupProps as Record<string, JsonValue>;
  }
  return canonical;
}

/**
 * Resolved context for reporting/telemetry: PostHog system directives
 * ($-prefixed) are filtered out; empty attributes omitted.
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
