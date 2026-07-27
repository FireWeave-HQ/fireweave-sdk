import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONTEXT_LIMITS,
  DEFAULT_RESERVED_ATTRIBUTE_KEYS,
  canonicalizeContext,
  mergeContexts,
  normalizeContextInput,
  FireweaveError,
} from '@fireweaveai/sdk';
import type { ContextPolicy } from '@fireweaveai/sdk';

const POLICY: ContextPolicy = {
  limits: DEFAULT_CONTEXT_LIMITS,
  reservedAttributeKeys: DEFAULT_RESERVED_ATTRIBUTE_KEYS,
  requireTargetingKey: false,
};

function merged(attributes: Record<string, unknown>, targetingKey = 'user-1') {
  return { targetingKey, attributes };
}

const isInvalidContext = (err: unknown): boolean =>
  err instanceof FireweaveError && err.kind === 'InvalidContext';

test('accepts a context at exactly the attribute-count bound (128)', () => {
  const attrs: Record<string, unknown> = {};
  for (let i = 0; i < 128; i += 1) attrs[`k${i}`] = i;
  const result = canonicalizeContext(merged(attrs), POLICY);
  assert.equal(Object.keys(result.attributes).length, 128);
});

test('rejects a context above the attribute-count bound (129)', () => {
  const attrs: Record<string, unknown> = {};
  for (let i = 0; i < 129; i += 1) attrs[`k${i}`] = i;
  assert.throws(() => canonicalizeContext(merged(attrs), POLICY), isInvalidContext);
});

test('rejects attribute keys longer than 256 bytes, accepts exactly 256', () => {
  assert.throws(
    () => canonicalizeContext(merged({ ['k'.repeat(257)]: 1 }), POLICY),
    isInvalidContext,
  );
  canonicalizeContext(merged({ ['k'.repeat(256)]: 1 }), POLICY);
});

test('rejects values above 4KiB serialized and depth above 6', () => {
  assert.throws(
    () => canonicalizeContext(merged({ big: 'x'.repeat(4097) }), POLICY),
    isInvalidContext,
  );
  const depth7 = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
  assert.throws(() => canonicalizeContext(merged({ deep: depth7 }), POLICY), isInvalidContext);
  // depth 6 exactly is fine
  canonicalizeContext(merged({ deep: { a: { b: { c: { d: { e: 1 } } } } } }), POLICY);
});

test('rejects reserved fireweave.* namespace keys', () => {
  assert.throws(
    () => canonicalizeContext(merged({ 'fireweave.internal': true }), POLICY),
    isInvalidContext,
  );
});

test('TARGETING_KEY_MISSING when policy requires targetingKey', () => {
  const strict: ContextPolicy = { ...POLICY, requireTargetingKey: true };
  assert.throws(
    () => canonicalizeContext({ attributes: {} }, strict),
    (err: unknown) =>
      err instanceof FireweaveError &&
      err.kind === 'InvalidContext' &&
      err.openFeatureErrorCode === 'TARGETING_KEY_MISSING',
  );
});

test('merge order is global -> client -> invocation', () => {
  const out = mergeContexts(
    { targetingKey: 'g', tier: 'global', region: 'us', env: 'prod' },
    { targetingKey: 'c', tier: 'client' },
    { targetingKey: 'i', region: 'eu' },
  );
  assert.equal(out.targetingKey, 'i');
  assert.equal(out.attributes.tier, 'client');
  assert.equal(out.attributes.region, 'eu');
  assert.equal(out.attributes.env, 'prod');
});

test('normalizeContextInput supports flat OpenFeature shape and attributes bag', () => {
  const flat = normalizeContextInput({ targetingKey: 'u', plan: 'pro' });
  assert.deepEqual(flat, { targetingKey: 'u', attributes: { plan: 'pro' } });
  const bagged = normalizeContextInput({ targetingKey: 'u', attributes: { plan: 'pro' } });
  assert.deepEqual(bagged, { targetingKey: 'u', attributes: { plan: 'pro' } });
});

test('canonicalization deep-copies: caller mutation is not observed afterwards', () => {
  const nested = { plan: 'pro', tags: ['a'] };
  const canonical = canonicalizeContext(merged({ nested }), POLICY);
  nested.plan = 'mutated';
  nested.tags.push('b');
  const snapshot = canonical.attributes.nested as { plan: string; tags: string[] };
  assert.equal(snapshot.plan, 'pro');
  assert.deepEqual(snapshot.tags, ['a']);
});

test('serialized context above 64KiB rejected', () => {
  const attrs: Record<string, unknown> = {};
  for (let i = 0; i < 20; i += 1) attrs[`k${i}`] = 'y'.repeat(4000);
  assert.throws(() => canonicalizeContext(merged(attrs), POLICY), isInvalidContext);
});
