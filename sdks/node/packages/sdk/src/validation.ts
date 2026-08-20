/**
 * Fireweave SDK validation — pure, total functions per spec/control-points.md
 * "Validation, before any I/O" and spec/modes.md "Initialisation validation".
 *
 * Every read-path validator here (`validateControlPointKey`,
 * `validateDefaultValue`, `validateContext`, `validateTargetingKey`) returns
 * `Validated<T>` instead of throwing. `FireweaveRuntime.evaluate` runs them,
 * in the fixed order the spec names — key, default-vs-type, context,
 * lifecycle — and degrades to the caller's default on the first failure; it
 * NEVER throws (spec/control-points.md "Return discipline — never throw into
 * a read path").
 *
 * `validateInitOptions` is the one named exception (spec/modes.md
 * "Initialisation validation"): its failures are converted to a THROW by
 * `initFireweave` (src/init.ts). The validator itself still returns
 * `Validated<T>` — the entry point does the throwing, not this module.
 *
 * Collected into one module so it can move wholesale into `domain/` (plan
 * Phase 1.4) without touching its exports or call sites again. Everything
 * below is pure (no I/O, no ambient state) and total (every branch returns a
 * `Validated<T>`) — `conformance/` can exercise all four read-path rules
 * offline, with no backend.
 *
 * `validateInitOptions` is deliberately generic rather than importing
 * `InitFireweaveOptions` from `init.ts`: init.ts is the "mode" entry point
 * (Phase 1.4 assigns it to `application/`), and this module is destined for
 * `domain/`, which must not depend on outer layers. It also does not
 * validate "apiUrl fails the host allowlist" (spec/modes.md row 3) — that
 * check (`assertHostAllowed`) lives in `hosts.ts`, which Phase 1.4 assigns to
 * `infrastructure/`; it stays reachable today via `FireweaveRuntime.initialize`
 * (runtime.ts) / `FireweaveRemoteAdapter.initialize` (adapters/remote.ts),
 * unchanged by this module.
 */
import { FireweaveError } from './errors.js';
import { ALLOWED_FIREWEAVE_CONTEXT_KEYS, type ContextPolicy } from './context.js';
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
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

const MAX_CONTROL_POINT_KEY_LENGTH = 256;

/**
 * key — non-empty, ≤256 characters, no control characters
 * (spec/control-points.md rule 1, the first check in the fixed order).
 *
 * No taxonomy kind names "malformed key" explicitly (the return-discipline
 * table's closest row is "key unknown to the backend" → FlagNotFound): a key
 * that can never identify a flag is treated the same as one the backend
 * doesn't recognise, so this maps to FlagNotFound too.
 */
export function validateControlPointKey(key: string): Validated<string> {
  if (typeof key !== 'string' || key.length === 0) {
    return fail(new FireweaveError('FlagNotFound', { message: 'control point key must be a non-empty string' }));
  }
  if (key.length > MAX_CONTROL_POINT_KEY_LENGTH) {
    return fail(new FireweaveError('FlagNotFound', { message: 'control point key exceeds maximum length' }));
  }
  if (CONTROL_CHARACTERS.test(key)) {
    return fail(new FireweaveError('FlagNotFound', { message: 'control point key contains control characters' }));
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
 * {@link validateDefaultValue} (the caller's default, before any I/O) and
 * `FireweaveRuntime.evaluate`'s post-resolve check (the backend's resolved
 * value, after I/O) — same predicate, two different inputs.
 */
export function matchesExpectedType(value: JsonValue, expected: ExpectedFlagType): boolean {
  switch (expected) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'object':
      return value !== null && typeof value === 'object';
  }
}

/**
 * default vs type — e.g. `getBooleanValue` with a non-boolean default is
 * TypeMismatch (spec/control-points.md rule 2, checked before any I/O).
 */
export function validateDefaultValue(
  expectedType: ExpectedFlagType,
  defaultValue: JsonValue,
): Validated<JsonValue> {
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
 * the remote adapter always requires one for `resolve`/`registerTarget`
 * (spec/remote-protocol.md "Two identity paths"); the generic context
 * pipeline ({@link validateContext}) only does when
 * `ContextPolicy.requireTargetingKey` opts in.
 */
export function validateTargetingKey(
  targetingKey: string | undefined,
  required: boolean,
): Validated<string | undefined> {
  if (required && (targetingKey === undefined || targetingKey === '')) {
    return fail(
      new FireweaveError('InvalidContext', {
        message: 'targeting key missing',
        openFeatureErrorCode: 'TARGETING_KEY_MISSING',
      }),
    );
  }
  return ok(targetingKey);
}

// ---------------------------------------------------------------------------
// Rule 3 — validateContext (spec/control-points.md rule 3: "context — depth,
// key count, value size, reserved keys (evaluation-context.schema.json)")
// ---------------------------------------------------------------------------

/**
 * UTF-8 byte length. `TextEncoder` rather than `Buffer.byteLength`: `Buffer`
 * is a Node global that Deno only exposes under npm compatibility, and this
 * bound is enforced on every evaluation (ADR-0008 runtime portability).
 */
const utf8Encoder = new TextEncoder();
const byteLength = (s: string): number => utf8Encoder.encode(s).length;

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

const invalidContext = (message: string): FireweaveError => new FireweaveError('InvalidContext', { message });

/**
 * context — depth, key count, value size, reserved keys
 * (evaluation-context.schema.json) (spec/control-points.md rule 3). Also
 * enforces `policy.requireTargetingKey` via {@link validateTargetingKey}, and
 * — on success — extracts `groups`/`groupProperties` the same way the former
 * `canonicalizeContext` did.
 *
 * `merged` is the already-merged (global → client → invocation) raw input;
 * merging itself (`mergeContexts`) lives in context.ts and carries no
 * validation concerns of its own.
 */
export function validateContext(
  merged: { targetingKey?: string; attributes: Record<string, unknown> },
  policy: ContextPolicy,
): Validated<CanonicalContext> {
  const { limits } = policy;
  const attributes = deepCopyJson(merged.attributes) as Record<string, JsonValue>;

  const keys = Object.keys(attributes);
  if (keys.length > limits.maxAttributeCount) {
    return fail(invalidContext('context exceeds maximum attribute count'));
  }
  for (const key of keys) {
    if (byteLength(key) > limits.maxKeyBytes) {
      return fail(invalidContext('context key exceeds maximum size'));
    }
  }
  for (const key of keys) {
    const value = attributes[key];
    if (byteLength(JSON.stringify(value ?? null)) > limits.maxValueBytes) {
      return fail(invalidContext('context value exceeds maximum size'));
    }
  }
  for (const key of keys) {
    const value = attributes[key];
    if (value !== undefined && nestingDepth(value) > limits.maxNestingDepth) {
      return fail(invalidContext('context exceeds maximum nesting depth'));
    }
  }
  const serialized = JSON.stringify({ targetingKey: merged.targetingKey, attributes });
  if (byteLength(serialized) > limits.maxSerializedContextBytes) {
    return fail(invalidContext('serialized context exceeds maximum size'));
  }
  for (const key of keys) {
    if (policy.reservedAttributeKeys.includes(key)) {
      return fail(invalidContext('invalid evaluation context'));
    }
    // Ruling 13: exactly fireweave.groups + fireweave.groupProperties are
    // permitted in the reserved namespace; every other fireweave.* key is rejected.
    if (key.startsWith('fireweave.') && !ALLOWED_FIREWEAVE_CONTEXT_KEYS.includes(key)) {
      return fail(invalidContext('invalid evaluation context'));
    }
  }
  const targetingKeyResult = validateTargetingKey(merged.targetingKey, policy.requireTargetingKey);
  if (!targetingKeyResult.ok) return targetingKeyResult;

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
  return ok(canonical);
}

/**
 * Throwing wrapper around {@link validateContext} kept for the pre-existing
 * public surface (`FireweaveRuntime.resolveContext`, direct callers of the
 * package export). Read paths do not use this — they call
 * {@link validateContext} directly so a failure degrades instead of throwing.
 */
export function canonicalizeContext(
  merged: { targetingKey?: string; attributes: Record<string, unknown> },
  policy: ContextPolicy,
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

const configError = (message: string): FireweaveError => new FireweaveError('Configuration', { message });

/**
 * Initialisation-validation table (spec/modes.md), rows 1, 2 and 4:
 *  - `mode` absent or unrecognised
 *  - `mode: 'remote'` with `apiKey` or `apiUrl` missing/blank
 *  - `mode: 'local'` with credentials supplied (a config half-migrated from
 *    remote to local reads as neither, silently — reject it instead)
 *
 * Row 3 ("apiUrl fails the host allowlist") is intentionally NOT checked
 * here — see the module doc comment.
 */
export function validateInitOptions<T extends { readonly mode?: unknown }>(options: T): Validated<T> {
  const mode = options?.mode;
  if (mode !== 'local' && mode !== 'remote') {
    return fail(configError('mode is required and must be "local" or "remote"'));
  }
  // Runtime-only guard: a config object half-migrated from remote to local
  // can carry apiKey/apiUrl even though the local-mode type declares
  // neither — TypeScript's excess-property check only fires on a fresh
  // object literal, not on a variable assembled elsewhere and passed in.
  const credentials = options as unknown as { apiKey?: unknown; apiUrl?: unknown };
  if (mode === 'remote') {
    if (isBlank(credentials.apiKey) || isBlank(credentials.apiUrl)) {
      return fail(configError('mode "remote" requires apiKey and apiUrl'));
    }
    return ok(options);
  }
  if (!isBlank(credentials.apiKey) || !isBlank(credentials.apiUrl)) {
    return fail(
      configError('mode "local" must not be combined with apiKey/apiUrl — the caller means one or the other'),
    );
  }
  return ok(options);
}
