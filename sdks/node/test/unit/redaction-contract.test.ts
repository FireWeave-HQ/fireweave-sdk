/**
 * Redaction parity: contracts/errors.json `rules.redaction` (contracts/errors.md
 * rule 2, start-profile SP-26). Every vector's `in` must come out of the real
 * redactor as exactly its `out`. The contract is read at test time, so a vector
 * added there is enforced here without editing this file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FireweaveError, redactSecrets } from '@fireweaveai/server-sdk';

interface RedactionRule {
  placeholder: string;
  assignmentNames: string[];
  valuePrefixes: string[];
  vectors: Array<{ in: string; out: string }>;
}

const here = dirname(fileURLToPath(import.meta.url));
const contractPath = join(here, '..', '..', '..', '..', 'contracts', 'errors.json');
const rule = (JSON.parse(readFileSync(contractPath, 'utf8')) as { rules: { redaction: RedactionRule } }).rules.redaction;

test('the contract carries vectors and the placeholder this SDK writes', () => {
  assert.equal(rule.placeholder, '[REDACTED]');
  assert.ok(rule.vectors.length >= 16, `expected at least 16 vectors, got ${rule.vectors.length}`);
});

for (const [i, vector] of rule.vectors.entries()) {
  test(`vector ${i}: ${JSON.stringify(vector.in)}`, () => {
    assert.equal(redactSecrets(vector.in), vector.out);
  });
}

test('FireweaveError messages go through the same redactor', () => {
  for (const vector of rule.vectors) {
    assert.equal(new FireweaveError('Internal', { message: vector.in }).message, vector.out);
  }
});

test('every key family and assigned name in the contract is scrubbed', () => {
  for (const prefix of rule.valuePrefixes) {
    assert.equal(redactSecrets(`x ${prefix}Ab9_-z y`), 'x [REDACTED] y', prefix);
    assert.equal(redactSecrets(`x ${prefix}… y`), `x ${prefix}… y`, `${prefix} as prose`);
  }
  for (const name of rule.assignmentNames) {
    assert.equal(redactSecrets(`${name}=s3cret`), `${name}=[REDACTED]`, name);
    assert.equal(redactSecrets(`${name} = 's3cret', next`), `${name} = '[REDACTED]', next`, name);
    assert.equal(redactSecrets(`set ${name} first`), `set ${name} first`, `${name} alone`);
  }
});

test('redaction is idempotent', () => {
  for (const vector of rule.vectors) {
    assert.equal(redactSecrets(vector.out), vector.out);
  }
});
