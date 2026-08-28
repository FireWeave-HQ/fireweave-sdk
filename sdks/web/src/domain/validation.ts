/**
 * Fireweave web SDK validation — pure, total functions per
 * spec/control-points.md "Validation, before any I/O" and spec/modes.md
 * "Initialisation validation".
 *
 * Ported from sdks/node/src/domain/validation.ts (the reference
 * implementation) — same five validators, same `Validated<T>` discipline,
 * same malformed-key → FlagNotFound mapping. Reimplemented here rather than
 * shared so the browser package keeps zero cross-package dependency to
 * audit — the same reasoning ADR-0009 gives for duplicating types.ts/errors.ts
 * extends to this module.
 *
 * Every read-path validator here (`validateControlPointKey`,
 * `validateDefaultValue`, `validateContext`) returns `Validated<T>` instead
 * of throwing. `FireweaveWebRuntime.evaluateSync` runs them, in the fixed
 * order the spec names — key, default-vs-type, context, lifecycle — and
 * degrades to the caller's default on the first failure; it NEVER throws
 * (spec/control-points.md "Return discipline — never throw into a read
 * path"). `validateInitOptions` is the one exception (spec/modes.md
 * "Initialisation validation"): it still returns `Validated<T>` — mode.ts is
 * what converts a failed result into the throw spec/modes.md requires.
 *
 * Note: unlike node, web's `FireweaveError` has no custom-message support —
 * messages are FIXED per kind by design, because a browser error is visible
 * in a devtools console on a machine this package does not control
 * (errors.ts's own doc comment). So every branch below that would carry a
 * distinct node message instead just uses the taxonomy's fixed message for
 * its kind.
 */
import { FireweaveError } from './errors.js';
import type { ContextPolicy } from './context.js';
import type { CanonicalContext, JsonValue } from './types.js';

/** Result of a pure validator: success carries the validated value, failure the canonical error. */
export type Validated<T> = { ok: true; value: T } | { ok: false; error: FireweaveError };

const ok = <T>(value: T): Validated<T> => ({ ok: true, value });
const fail = <T>(error: FireweaveError): Validated<T> => ({ ok: false, error });

// ---------------------------------------------------------------------------
// Rule 1 — validateControlPointKey (spec/control-points.md "Validation,
// before any I/O": "key — non-empty, ≤256 characters, no control characters")
// ---------------------------------------------------------------------------

/** C0 + C1 control characters (U+0000-U+001F, U+007F-U+009F). */
const CONTROL_CHARACTERS = new RegExp(
  '[' + String.fromCharCode(0x00) + '-' + String.fromCharCode(0x1f) +
  String.fromCharCode(0x7f) + '-' + String.fromCharCode(0x9f) + ']'
);

const MAX_CONTROL_POINT_KEY_LENGTH = 256;

/**
 * key — non-empty, ≤256 characters, no control characters
 * (spec/control-points.md rule 1, the first check in the fixed order).
 *
 * No taxonomy kind names "malformed key" explicitly (the return-discipline
 * table's closest row is "key unknown to the backend" → FlagNotFound):
 * controller-ruled interim mapping (mirrors node's domain/validation.ts
 * verbatim) — the 15-kind taxonomy in errors.schema.json is frozen at
 * exactly 15 entries, `InvalidContext` is textually scoped to the evaluation
 * *context* (not the key), and the schema already maps another non-literal
 * case — quota-limited responses — onto `FlagNotFound` rather than adding a
 * kind for it. `FlagNotFound` is therefore the least-wrong existing kind,
 * not a literal fit. Other-language implementations copying node as the
 * reference SHOULD use the same mapping rather than each independently
 * guessing a different one.
 */
export function validateControlPointKey(key: string): Validated<string> {
  if (typeof key !== 'string' || key.length === 0) {
    return fail(new FireweaveError('FlagNotFound'));
  }
  if (key.length > MAX_CONTROL_POINT_KEY_LENGTH) {
    return fail(new FireweaveError('FlagNotFound'));
  }
  if (CONTROL_CHARACTERS.test(key)) {
    return fail(new FireweaveError('FlagNotFound'));
  }
  return ok(key);
}

// ---------------------------------------------------------------------------
// Rule 2 — validateDefaultValue (spec/control-points.md rule 2: "default vs
// type — getBooleanValue with a non-boolean default is TypeMismatch")
// ---------------------------------------------------------------------------

export type ExpectedFlagType = 'boolean' | 'string' | 'number' | 'object';

/**
 * Whether `value` matches the shape `expected` names. Shared by
 * {@link validateDefaultValue} (the caller's default, before any read) and
 * `FireweaveWebRuntime.evaluateSync`'s post-cache-lookup check (the backend's
 * resolved value, from the prefetched cache) — same predicate, two different
 * inputs.
 */
export function matchesExpectedType(value: JsonValue | undefined, expected: ExpectedFlagType): boolean {
  switch (expected) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'object':
      return typeof value === 'object' && value !== null;
  }
}

/**
 * default vs type — e.g. `getBooleanValue` with a non-boolean default is
 * TypeMismatch (spec/control-points.md rule 2, checked before any read).
 */
export function validateDefaultValue(expectedType: ExpectedFlagType, defaultValue: JsonValue): Validated<JsonValue> {
  if (!matchesExpectedType(defaultValue, expectedType)) {
    return fail(new FireweaveError('TypeMismatch'));
  }
  return ok(defaultValue);
}

// ---------------------------------------------------------------------------
// validateTargetingKey (spec/control-points.md "Context": targetingKey)
// ---------------------------------------------------------------------------

/**
 * targetingKey: "An SDK MUST NOT invent one: a missing targeting key is
 * InvalidContext where the evaluation needs it, never a generated anonymous
 * id" (spec/control-points.md "Context"). `required` is call-site policy —
 * the remote adapter always requires one for `prefetch`/`registerTarget`; the
 * generic context pipeline ({@link validateContext}) only does when
 * `ContextPolicy.requireTargetingKey` opts in (unset by default here — web's
 * targetingKey requirement is enforced at the remote adapter, not the
 * general-purpose context validator every read runs).
 */
export function validateTargetingKey(
  targetingKey: string | undefined,
  required: boolean
): Validated<string | undefined> {
  if (required && (targetingKey === undefined || targetingKey === '')) {
    return fail(new FireweaveError('InvalidContext', { openFeatureErrorCode: 'TARGETING_KEY_MISSING' }));
  }
  return ok(targetingKey);
}

// ---------------------------------------------------------------------------
// Rule 3 — validateContext (spec/control-points.md rule 3: "context — depth,
// key count, value size, reserved keys (evaluation-context.schema.json)")
// ---------------------------------------------------------------------------

/**
 * UTF-8 byte length. `TextEncoder` rather than `Buffer.byteLength` — `Buffer`
 * does not exist in a browser at all (browser-portability.test.ts pins this).
 */
const utf8Encoder = new TextEncoder();
const byteLength = (s: string): number => utf8Encoder.encode(s).length;

/**
 * Sentinel returned (never thrown) when `deepCopyJson` walks back into an
 * object already on the current recursion path — an actual reference cycle,
 * not merely the same object shared by two sibling branches (which is legal
 * and handled by backtracking `seen.delete(...)` below). Untyped caller
 * input is `unknown`, so a circular attribute value is reachable from a
 * caller today; without this, recursion never terminates and crashes with
 * `RangeError: Maximum call stack size exceeded` — exactly the kind of throw
 * a "before any I/O" validator must not allow (spec/control-points.md
 * "Return discipline — never throw into a read path"). Module-local: never
 * returned across this file's public surface, only used to fail
 * `validateContext` closed as `InvalidContext`.
 */
const CYCLIC: unique symbol = Symbol('fireweave.cyclicJson');

function deepCopyJson(value: unknown, seen: WeakSet<object> = new WeakSet()): JsonValue | typeof CYCLIC {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return CYCLIC;
    seen.add(value);
    const out: JsonValue[] = [];
    for (const v of value) {
      const copied = deepCopyJson(v, seen);
      if (copied === CYCLIC) return CYCLIC;
      out.push(copied);
    }
    seen.delete(value);
    return out;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return CYCLIC;
    seen.add(value);
    const out: { [key: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        const copied = deepCopyJson(v, seen);
        if (copied === CYCLIC) return CYCLIC;
        out[k] = copied;
      }
    }
    seen.delete(value);
    return out;
  }
  return null;
}

/**
 * Cycle-safe defensively: `nestingDepth` only ever runs on `deepCopyJson`'s
 * own output today, which is guaranteed acyclic by construction (it builds
 * fresh containers, never back-references). Guarded anyway per the same
 * "must be genuinely total" reasoning as `deepCopyJson`. A detected cycle
 * returns `Infinity`, which always exceeds `limits.maxNestingDepth` and fails
 * closed through the existing bound check below — no new failure path.
 */
function nestingDepth(value: JsonValue, seen: WeakSet<object> = new WeakSet()): number {
  if (value === null || typeof value !== 'object') return 0;
  if (seen.has(value)) return Infinity;
  seen.add(value);
  let max = 0;
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    const d = nestingDepth(child, seen);
    if (d > max) max = d;
  }
  seen.delete(value);
  return max + 1;
}

const invalidContext = (): FireweaveError => new FireweaveError('InvalidContext');

/** groups/groupProperties carriers: canonical fireweave.* spelling first, then the plain alias. */
function extractSpecialKey(attributes: Record<string, unknown>, canonicalKey: string, aliasKey: string): unknown {
  if (canonicalKey in attributes) return attributes[canonicalKey];
  if (aliasKey in attributes) return attributes[aliasKey];
  return undefined;
}

/**
 * context — depth, key count, value size, reserved keys
 * (evaluation-context.schema.json) (spec/control-points.md rule 3). Also
 * enforces `policy.requireTargetingKey` via {@link validateTargetingKey}, and
 * — on success — extracts `groups`/`groupProperties` the same way the former
 * `canonicalizeContext` did.
 *
 * `groups`/`groupProperties` (and their `fireweave.*` aliases) are pulled out
 * BEFORE the attribute-count/size limit checks run, matching the pre-existing
 * behaviour this module replaces: they are not ordinary attributes and were
 * never counted against those limits.
 *
 * `merged` is the already-merged (global → invocation) raw input; merging
 * itself (`mergeContexts`) lives in context.ts and carries no validation
 * concerns of its own.
 */
export function validateContext(
  merged: { targetingKey?: string; attributes: Record<string, unknown> },
  policy: ContextPolicy
): Validated<CanonicalContext> {
  const { limits } = policy;
  const rawAttributes = { ...merged.attributes };
  const rawGroups = extractSpecialKey(rawAttributes, 'fireweave.groups', 'groups');
  const rawGroupProperties = extractSpecialKey(rawAttributes, 'fireweave.groupProperties', 'groupProperties');
  delete rawAttributes['fireweave.groups'];
  delete rawAttributes['groups'];
  delete rawAttributes['fireweave.groupProperties'];
  delete rawAttributes['groupProperties'];

  const copied = deepCopyJson(rawAttributes);
  if (copied === CYCLIC) {
    return fail(invalidContext());
  }
  const attributes = copied as Record<string, JsonValue>;

  const keys = Object.keys(attributes);
  if (keys.length > limits.maxAttributeCount) {
    return fail(invalidContext());
  }
  for (const key of keys) {
    if (byteLength(key) > limits.maxKeyBytes) {
      return fail(invalidContext());
    }
  }
  for (const key of keys) {
    const value = attributes[key];
    if (byteLength(JSON.stringify(value ?? null)) > limits.maxValueBytes) {
      return fail(invalidContext());
    }
  }
  for (const key of keys) {
    const value = attributes[key];
    if (value !== undefined && nestingDepth(value) > limits.maxNestingDepth) {
      return fail(invalidContext());
    }
  }
  const serialized = JSON.stringify({ targetingKey: merged.targetingKey, attributes });
  if (byteLength(serialized) > limits.maxSerializedBytes) {
    return fail(invalidContext());
  }
  for (const key of keys) {
    if (policy.reservedAttributeKeys.includes(key)) {
      return fail(invalidContext());
    }
  }

  const targetingKeyResult = validateTargetingKey(merged.targetingKey, policy.requireTargetingKey);
  if (!targetingKeyResult.ok) return targetingKeyResult;

  let groups: Record<string, string> | undefined;
  if (rawGroups !== undefined) {
    const g = deepCopyJson(rawGroups);
    if (g !== CYCLIC && g !== null && typeof g === 'object' && !Array.isArray(g)) {
      const entries = Object.entries(g as Record<string, JsonValue>);
      if (entries.every(([, v]) => typeof v === 'string')) {
        groups = Object.fromEntries(entries) as Record<string, string>;
      }
    }
  }

  let groupProperties: Record<string, Record<string, JsonValue>> | undefined;
  if (rawGroupProperties !== undefined) {
    const gp = deepCopyJson(rawGroupProperties);
    if (gp !== CYCLIC && gp !== null && typeof gp === 'object' && !Array.isArray(gp)) {
      groupProperties = gp as Record<string, Record<string, JsonValue>>;
    }
  }

  const canonical: CanonicalContext = {
    attributes,
    ...(merged.targetingKey !== undefined ? { targetingKey: merged.targetingKey } : {}),
    ...(groups !== undefined ? { groups } : {}),
    ...(groupProperties !== undefined ? { groupProperties } : {}),
  };
  return ok(canonical);
}

/**
 * Throwing wrapper around {@link validateContext}, kept for callers that
 * genuinely want a throw (`FireweaveWebRuntime.refresh`, which is already
 * inside its own try/catch feeding lifecycle state — see runtime.ts). Read
 * paths do not use this — they call {@link validateContext} directly so a
 * failure degrades instead of throwing.
 */
export function canonicalizeContext(
  merged: { targetingKey?: string; attributes: Record<string, unknown> },
  policy: ContextPolicy
): CanonicalContext {
  const result = validateContext(merged, policy);
  if (!result.ok) throw result.error;
  return result.value;
}

// ---------------------------------------------------------------------------
// validateInitOptions (spec/modes.md "Initialisation validation")
// ---------------------------------------------------------------------------

/** "missing" and "blank" collapse to one check: not a non-empty string. */
const isBlank = (value: unknown): boolean => typeof value !== 'string' || value.trim().length === 0;

const configError = (): FireweaveError => new FireweaveError('Configuration');

/**
 * Initialisation-validation table (spec/modes.md), rows 1, 2 and 4:
 *  - `mode` absent or unrecognised
 *  - `mode: 'remote'` with `apiKey` or `apiUrl` missing/blank
 *  - `mode: 'local'` with credentials supplied (a config half-migrated from
 *    remote to local reads as neither, silently — reject it instead)
 *
 * Row 3 ("apiUrl fails the host allowlist") is intentionally NOT checked
 * here — mode.ts validates it directly via `assertHostAllowed` before
 * calling into the (deliberately non-throwing) runtime; see mode.ts's module
 * doc comment for why web cannot rely on the runtime the way node does.
 */
export function validateInitOptions<T extends { readonly mode?: unknown }>(options: T): Validated<T> {
  const mode = options?.mode;
  if (mode !== 'local' && mode !== 'remote') {
    return fail(configError());
  }
  // Runtime-only guard: a config object half-migrated from remote to local
  // can carry apiKey/apiUrl even though the local-mode type declares
  // neither — TypeScript's excess-property check only fires on a fresh
  // object literal, not on a variable assembled elsewhere and passed in.
  const credentials = options as unknown as { apiKey?: unknown; apiUrl?: unknown };
  if (mode === 'remote') {
    if (isBlank(credentials.apiKey) || isBlank(credentials.apiUrl)) {
      return fail(configError());
    }
    return ok(options);
  }
  if (!isBlank(credentials.apiKey) || !isBlank(credentials.apiUrl)) {
    return fail(configError());
  }
  return ok(options);
}
