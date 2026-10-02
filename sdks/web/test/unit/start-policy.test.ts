/**
 * The pure policy shared by the browser start() and the build helpers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePolicy, sourced, type PolicyInput } from '../../src/start/policy.ts';

const base = { channel: 'production', keyVariable: 'FIREWEAVE_BROWSER_KEY', environmentChecked: 'FIREWEAVE_ENV' } as const;
const run = (input: Partial<PolicyInput>) => resolvePolicy({ ...base, ...input });
const env = (value: string) => sourced(value, 'FIREWEAVE_ENV');
const key = (value: string) => sourced(value, 'FIREWEAVE_BROWSER_KEY');

test('a browser key means remote on the channel host', () => {
  const r = run({ key: key('fw_public_x') });
  assert.ok(r.ok);
  assert.equal(r.config.mode, 'remote');
  assert.equal(r.config.modeSource, 'key');
  assert.equal(r.config.url, 'https://app-server.fireweave.ai');
  assert.equal(r.config.allowedHosts, undefined);
});

test('a staging build defaults to the staging host', () => {
  const r = resolvePolicy({ ...base, channel: 'staging', key: key('fw_public_x') });
  assert.ok(r.ok);
  assert.equal(r.config.url, 'https://staging-app-server.fireweave.ai');
});

test('dev environment names mean local, trimmed and case-insensitive', () => {
  for (const name of ['development', 'Development', ' dev ', 'LOCAL', 'test']) {
    const r = run({ environment: env(name) });
    assert.ok(r.ok && r.config.mode === 'local', name);
  }
});

test('blank values count as unset', () => {
  assert.equal(sourced('   ', 'x'), undefined);
  assert.equal(sourced(42, 'x'), undefined);
  const r = run({ key: key('  '), environment: env('') });
  assert.ok(!r.ok && r.reason === 'missing-key');
});

test('a custom URL scopes the allowlist to its host plus loopback', () => {
  const r = run({ key: key('fw_public_x'), url: sourced('https://fw.example.com/', 'FIREWEAVE_URL') });
  assert.ok(r.ok);
  assert.equal(r.config.url, 'https://fw.example.com');
  assert.deepEqual(r.config.allowedHosts, ['fw.example.com', 'localhost', '127.0.0.1', '::1']);
});

test('http is allowed on loopback only; protocol-relative is refused', () => {
  assert.ok(run({ key: key('fw_public_x'), url: sourced('http://localhost:3001', 'u') }).ok);
  const off = run({ key: key('fw_public_x'), url: sourced('http://fw.example.com', 'u') });
  assert.ok(!off.ok && off.reason === 'insecure-url');
  const rel = run({ key: key('fw_public_x'), url: sourced('//cdn.example.com', 'u') });
  assert.ok(!rel.ok && rel.reason === 'insecure-url');
});

test('an invalid mode is refused; remote without a key is missing-key', () => {
  const bad = run({ mode: 'auto' });
  assert.ok(!bad.ok && bad.reason === 'invalid-mode');
  const remote = run({ mode: 'remote' });
  assert.ok(!remote.ok && remote.reason === 'missing-key');
});

test('failure messages name the source and never echo a key', () => {
  for (const value of ['project-api-key_secret99', 'fw_org_secret99', 'cli_at_secret99', 'other_secret99']) {
    const r = run({ key: key(value) });
    assert.ok(!r.ok);
    assert.match(r.message, /FIREWEAVE_BROWSER_KEY/);
    assert.doesNotMatch(r.message, /secret99/);
  }
});
