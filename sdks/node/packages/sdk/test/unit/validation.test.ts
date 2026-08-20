/**
 * Pure, offline coverage for the five validators (spec/control-points.md
 * "Validation, before any I/O" + spec/modes.md "Initialisation validation").
 * No adapter, no runtime, no network — every case here is a direct function
 * call, proving these are reachable without a backend.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONTEXT_LIMITS,
  DEFAULT_RESERVED_ATTRIBUTE_KEYS,
  FireweaveError,
  validateControlPointKey,
  validateDefaultValue,
  validateContext,
  validateTargetingKey,
  validateInitOptions,
} from '@fireweaveai/sdk';
import type { ContextPolicy } from '@fireweaveai/sdk';

const POLICY: ContextPolicy = {
  limits: DEFAULT_CONTEXT_LIMITS,
  reservedAttributeKeys: DEFAULT_RESERVED_ATTRIBUTE_KEYS,
  requireTargetingKey: false,
};

// ---------------------------------------------------------------------------
// validateControlPointKey — rule 1: non-empty, <=256 chars, no control chars
// ---------------------------------------------------------------------------

test('validateControlPointKey: ok arm for an ordinary key', () => {
  const result = validateControlPointKey('checkout-v2');
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.value === 'checkout-v2');
});

test('validateControlPointKey: rejects an empty key', () => {
  const result = validateControlPointKey('');
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error instanceof FireweaveError);
  assert.ok(!result.ok && result.error.kind === 'FlagNotFound');
});

test('validateControlPointKey: accepts exactly 256 characters, rejects 257', () => {
  const at256 = validateControlPointKey('k'.repeat(256));
  assert.equal(at256.ok, true);

  const at257 = validateControlPointKey('k'.repeat(257));
  assert.equal(at257.ok, false);
  assert.ok(!at257.ok && at257.error.kind === 'FlagNotFound');
});

test('validateControlPointKey: rejects a key containing a control character', () => {
  const withNewline = validateControlPointKey('checkout\nv2');
  assert.equal(withNewline.ok, false);
  assert.ok(!withNewline.ok && withNewline.error.kind === 'FlagNotFound');

  const withNul = validateControlPointKey('checkout\u0000v2');
  assert.equal(withNul.ok, false);

  const withDel = validateControlPointKey('checkout\u007fv2');
  assert.equal(withDel.ok, false);
});

// ---------------------------------------------------------------------------
// validateDefaultValue — rule 2: default vs type
// ---------------------------------------------------------------------------

test('validateDefaultValue: ok arm when default matches the expected type', () => {
  assert.equal(validateDefaultValue('boolean', false).ok, true);
  assert.equal(validateDefaultValue('string', 'classic').ok, true);
  assert.equal(validateDefaultValue('number', 0).ok, true);
  assert.equal(validateDefaultValue('object', { a: 1 }).ok, true);
  assert.equal(validateDefaultValue('object', null).ok, false, 'null is not an object default');
});

test('validateDefaultValue: getBooleanValue-shaped call with a non-boolean default is TypeMismatch', () => {
  const result = validateDefaultValue('boolean', 'not-a-boolean');
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error instanceof FireweaveError);
  assert.ok(!result.ok && result.error.kind === 'TypeMismatch');
});

test('validateDefaultValue: rejects mismatches for every expected type', () => {
  assert.equal(validateDefaultValue('string', 1).ok, false);
  assert.equal(validateDefaultValue('number', 'nope').ok, false);
  assert.equal(validateDefaultValue('object', 'nope').ok, false);
});

// ---------------------------------------------------------------------------
// validateTargetingKey (spec/control-points.md "Context")
// ---------------------------------------------------------------------------

test('validateTargetingKey: ok arm passes the key through unchanged when not required', () => {
  const present = validateTargetingKey('user-1', false);
  assert.equal(present.ok, true);
  assert.ok(present.ok && present.value === 'user-1');

  const absent = validateTargetingKey(undefined, false);
  assert.equal(absent.ok, true);
  assert.ok(absent.ok && absent.value === undefined);
});

test('validateTargetingKey: never invents one — missing + required is InvalidContext', () => {
  const missing = validateTargetingKey(undefined, true);
  assert.equal(missing.ok, false);
  assert.ok(!missing.ok && missing.error.kind === 'InvalidContext');
  assert.ok(!missing.ok && missing.error.openFeatureErrorCode === 'TARGETING_KEY_MISSING');

  const blank = validateTargetingKey('', true);
  assert.equal(blank.ok, false);
  assert.ok(!blank.ok && blank.error.kind === 'InvalidContext');
});

test('validateTargetingKey: present + required is ok', () => {
  const result = validateTargetingKey('user-1', true);
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.value === 'user-1');
});

// ---------------------------------------------------------------------------
// validateContext — rule 3: depth, key count, value size, reserved keys
// ---------------------------------------------------------------------------

test('validateContext: ok arm returns the canonical context', () => {
  const result = validateContext({ targetingKey: 'user-1', attributes: { plan: 'pro' } }, POLICY);
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.value.targetingKey === 'user-1');
  assert.ok(result.ok && result.value.attributes.plan === 'pro');
});

test('validateContext: rejects a context above the attribute-count bound', () => {
  const attrs: Record<string, unknown> = {};
  for (let i = 0; i < 129; i += 1) attrs[`k${i}`] = i;
  const result = validateContext({ attributes: attrs }, POLICY);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.kind === 'InvalidContext');
});

test('validateContext: rejects an attribute key over the byte bound', () => {
  const result = validateContext({ attributes: { ['k'.repeat(257)]: 1 } }, POLICY);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.kind === 'InvalidContext');
});

test('validateContext: rejects a reserved attribute key', () => {
  const result = validateContext({ attributes: { kind: 'user' } }, POLICY);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.kind === 'InvalidContext');
});

test('validateContext: enforces requireTargetingKey via validateTargetingKey (TARGETING_KEY_MISSING)', () => {
  const strict: ContextPolicy = { ...POLICY, requireTargetingKey: true };
  const result = validateContext({ attributes: {} }, strict);
  assert.equal(result.ok, false);
  assert.ok(
    !result.ok && result.error.kind === 'InvalidContext' && result.error.openFeatureErrorCode === 'TARGETING_KEY_MISSING',
  );
});

// ---------------------------------------------------------------------------
// validateInitOptions (spec/modes.md "Initialisation validation")
// ---------------------------------------------------------------------------

test('validateInitOptions: ok arm passes remote options through unchanged', () => {
  const options = { mode: 'remote' as const, apiKey: 'project-api-key_test', apiUrl: 'https://app-server.fireweave.ai' };
  const result = validateInitOptions(options);
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.value === options, 'validated value is the same options object');
});

test('validateInitOptions: ok arm passes local options through unchanged', () => {
  const options = { mode: 'local' as const, local: { controlPoints: { a: true } } };
  const result = validateInitOptions(options);
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.value === options);
});

test('validateInitOptions: mode absent or unrecognised is Configuration', () => {
  const missing = validateInitOptions({} as { mode?: unknown });
  assert.equal(missing.ok, false);
  assert.ok(!missing.ok && missing.error.kind === 'Configuration');

  const bad = validateInitOptions({ mode: 'staging' } as { mode?: unknown });
  assert.equal(bad.ok, false);
  assert.ok(!bad.ok && bad.error.kind === 'Configuration');
});

test('validateInitOptions: remote mode with apiKey or apiUrl missing/blank is Configuration', () => {
  const noApiKey = validateInitOptions({ mode: 'remote' as const, apiUrl: 'https://app-server.fireweave.ai' });
  assert.equal(noApiKey.ok, false);
  assert.ok(!noApiKey.ok && noApiKey.error.kind === 'Configuration');

  const blankApiUrl = validateInitOptions({
    mode: 'remote' as const,
    apiKey: 'project-api-key_test',
    apiUrl: '   ',
  });
  assert.equal(blankApiUrl.ok, false);
});

test('validateInitOptions: local mode with credentials supplied is Configuration', () => {
  const result = validateInitOptions({ mode: 'local' as const, apiKey: 'project-api-key_test' });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.kind === 'Configuration');
});

test('validateInitOptions: local mode with blank apiKey/apiUrl is not treated as "supplied"', () => {
  const result = validateInitOptions({ mode: 'local' as const, apiKey: '', apiUrl: '   ' });
  assert.equal(result.ok, true);
});
