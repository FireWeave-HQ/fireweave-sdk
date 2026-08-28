import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_TAXONOMY, FireweaveError, redactSecrets } from '@fireweaveai/server-sdk';

test('taxonomy has exactly the 15 canonical kinds', () => {
  const kinds = Object.keys(ERROR_TAXONOMY).sort();
  assert.deepEqual(kinds, [
    'AlreadyClosed',
    'Authentication',
    'Authorization',
    'BackendUnavailable',
    'Configuration',
    'FlagNotFound',
    'Internal',
    'InvalidContext',
    'MalformedResponse',
    'Network',
    'NotReady',
    'RateLimited',
    'Timeout',
    'TypeMismatch',
    'UnsupportedCapability',
  ]);
  assert.equal(kinds.length, 15);
});

test('taxonomy matches contracts/errors.json mappings', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const contractPath = join(here, '..', '..', '..', '..', 'contracts', 'errors.json');
  const contract = JSON.parse(readFileSync(contractPath, 'utf8')) as {
    errors: Array<{ kind: string; openFeatureErrorCode: string; retryable: boolean; defaultMessage: string }>;
  };
  for (const entry of contract.errors) {
    const spec = ERROR_TAXONOMY[entry.kind as keyof typeof ERROR_TAXONOMY];
    assert.ok(spec !== undefined, `missing kind ${entry.kind}`);
    assert.equal(spec.openFeatureErrorCode, entry.openFeatureErrorCode, entry.kind);
    assert.equal(spec.retryable, entry.retryable, entry.kind);
    assert.equal(spec.defaultMessage, entry.defaultMessage, entry.kind);
  }
});

test('AlreadyClosed maps to PROVIDER_NOT_READY', () => {
  assert.equal(ERROR_TAXONOMY.AlreadyClosed.openFeatureErrorCode, 'PROVIDER_NOT_READY');
});

test('redactSecrets strips API keys and bearer tokens', () => {
  const input = 'auth failed for phc_SUPERSECRET123 with Bearer abc.def.ghi and phs_topsecret';
  const out = redactSecrets(input);
  assert.ok(!out.includes('phc_'), out);
  assert.ok(!out.includes('SUPERSECRET'), out);
  assert.ok(!out.includes('abc.def.ghi'), out);
  assert.ok(!out.includes('phs_'), out);
});

test('FireweaveError preserves cause internally, redacts message', () => {
  const cause = new Error('backend said phc_ABC123 is invalid');
  const err = new FireweaveError('Authentication', { message: cause.message, cause });
  assert.equal(err.cause, cause);
  assert.ok(!err.message.includes('phc_ABC123'));
  assert.equal(err.safeMessage, 'authentication failed');
  assert.equal(err.kind, 'Authentication');
  assert.equal(err.openFeatureErrorCode, 'GENERAL');
});

test('default messages carry no secrets and are deterministic', () => {
  for (const spec of Object.values(ERROR_TAXONOMY)) {
    assert.ok(!/ph[csx]_/.test(spec.defaultMessage));
    assert.equal(new FireweaveError(spec.kind).message, spec.defaultMessage);
  }
});
