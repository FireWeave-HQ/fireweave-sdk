/**
 * v2 → v3 backward-compatibility guard.
 *
 * This file encodes a promise: an application written against v2 keeps working
 * on v3 without edits, except for the three documented breaks (the
 * `@fireweaveai/sdk/posthog` subpath, the `posthog-node` peer dependency, and
 * `'posthog'` in two type unions) — see docs/adr/0006.
 *
 * DO NOT edit an assertion here to make a change pass. A failure means the
 * change removes public surface that consumers depend on. Either keep the
 * surface, or retire it deliberately in a major with its own ADR.
 *
 * The value-export list was captured from the v2.0.0 build. Names may be ADDED
 * to the SDK freely — this is a subset check, not an equality check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sdk from '@fireweaveai/sdk';
import {
  FireweaveClient,
  FireweaveRuntime,
  InMemoryAdapter,
} from '@fireweaveai/sdk';

/** Every value export the v2.0.0 entrypoint published. */
const V2_VALUE_EXPORTS: readonly string[] = [
  'ALLOWED_FIREWEAVE_CONTEXT_KEYS',
  'DEFAULT_ALLOWED_HOSTS',
  'DEFAULT_CONTEXT_LIMITS',
  'DEFAULT_RESERVED_ATTRIBUTE_KEYS',
  'DEFAULT_SHUTDOWN_TIMEOUT_MS',
  'DEFAULT_SIGNAL_ATTRIBUTE_ALLOWLIST',
  'ERROR_TAXONOMY',
  'FireweaveClient',
  'FireweaveError',
  'FireweaveProvider',
  'FireweaveRemoteAdapter',
  'FireweaveRuntime',
  'InMemoryAdapter',
  'assertHostAllowed',
  'canonicalizeContext',
  'isFireweaveError',
  'isLoopbackHostname',
  'mergeContexts',
  'normalizeContextInput',
  'redactSecrets',
  'resolvedContextView',
  'stableStringify',
];

/** Capability strings v2 accepted through invokeCapability. */
const V2_CAPABILITIES: readonly string[] = [
  'releases.setContext',
  'releases.start',
  'releases.complete',
  'releases.fail',
  'exposures.record',
  'exposures.flush',
  'signals.recordHealth',
  'signals.recordError',
  'signals.recordMetric',
  'signals.recordOutcome',
  'capabilities.get',
];

const BOOL_FLAG = {
  'new-checkout': { type: 'boolean', enabled: true, value: true, variant: 'on' },
} as const;

async function readyClient(): Promise<FireweaveClient> {
  const runtime = new FireweaveRuntime(
    new InMemoryAdapter({ flags: { ...BOOL_FLAG } }),
  );
  await runtime.initialize();
  return new FireweaveClient(runtime);
}

test('every v2 value export is still exported', () => {
  const present = new Set(Object.keys(sdk));
  const missing = V2_VALUE_EXPORTS.filter((name) => !present.has(name));
  assert.deepEqual(missing, [], `v2 exports removed: ${missing.join(', ')}`);
});

test('client.flags is the same object as client.controlPoints, not a copy', async () => {
  const client = await readyClient();
  assert.ok(client.controlPoints !== undefined, 'client.controlPoints is missing');
  assert.equal(
    client.flags,
    client.controlPoints,
    'the alias must share object identity so state stays coherent',
  );
  await client.shutdown();
});

test('the deprecated alias stays silent unless FW_DEPRECATION_WARNINGS=1', async () => {
  const original = console.warn;
  const seen: unknown[] = [];
  console.warn = (...args: unknown[]) => {
    seen.push(args);
  };
  try {
    const client = await readyClient();
    void client.flags;
    void client.flags;
    await client.shutdown();
  } finally {
    console.warn = original;
  }
  assert.deepEqual(seen, [], 'accessing client.flags must not warn by default');
});

test('FW_DEPRECATION_WARNINGS=1 emits exactly one notice per process', async () => {
  // The "already warned" flag is module-level and therefore per-process, so this
  // runs in a child process: in-process the flag may already be set by an
  // earlier test, which would hide a broken first-use notice.
  const here = dirname(fileURLToPath(import.meta.url));
  const distIndex = join(here, '..', '..', 'dist', 'index.js');
  const script = [
    `import { FireweaveClient, FireweaveRuntime, InMemoryAdapter } from ${JSON.stringify(distIndex)};`,
    `const runtime = new FireweaveRuntime(new InMemoryAdapter({ flags: {} }));`,
    `await runtime.initialize();`,
    `const client = new FireweaveClient(runtime);`,
    `void client.flags; void client.flags; void client.flags;`,
    `await runtime.shutdown();`,
  ].join('\n');

  const { spawnSync } = await import('node:child_process');
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });

  const enabled = run({ FW_DEPRECATION_WARNINGS: '1' });
  assert.equal(enabled.status, 0, `child exited ${enabled.status}: ${enabled.stderr}`);
  const notices = enabled.stderr.split('\n').filter((l) => l.includes('[fireweave]'));
  assert.equal(notices.length, 1, `expected one notice, got ${notices.length}:\n${enabled.stderr}`);
  assert.match(notices[0] ?? '', /client\.flags/);
  assert.match(notices[0] ?? '', /client\.controlPoints/);
  assert.match(notices[0] ?? '', /no migration is required/i);

  const disabled = run({ FW_DEPRECATION_WARNINGS: '' });
  assert.equal(disabled.status, 0, `child exited ${disabled.status}: ${disabled.stderr}`);
  assert.equal(
    disabled.stderr.includes('[fireweave]'),
    false,
    `unset FW_DEPRECATION_WARNINGS must stay silent:\n${disabled.stderr}`,
  );
});

test('client.flags namespace still exists and still evaluates', async () => {
  const client = await readyClient();

  assert.ok(client.flags !== undefined, 'client.flags was removed');

  const decision = await client.flags.evaluate('new-checkout', 'boolean', false, {
    targetingKey: 'user_42',
  });
  assert.equal(decision.value, true);
  assert.equal(decision.flagKey, 'new-checkout');

  assert.equal(
    await client.flags.getBooleanValue('new-checkout', false, { targetingKey: 'user_42' }),
    true,
  );
  assert.equal(
    await client.flags.getStringValue('missing-string', 'fallback', { targetingKey: 'user_42' }),
    'fallback',
  );
  assert.equal(
    await client.flags.getNumberValue('missing-number', 7, { targetingKey: 'user_42' }),
    7,
  );
  assert.deepEqual(
    await client.flags.getObjectValue('missing-object', { a: 1 }, { targetingKey: 'user_42' }),
    { a: 1 },
  );

  await client.shutdown();
});

test('capabilities.get still reports features.flags — pinned by contracts/extensions/ext-capabilities-get.json', async () => {
  const client = await readyClient();
  const caps = client.capabilities.get();

  assert.equal(caps.static.features['flags'], true, 'features.flags must stay true');
  assert.equal(caps.static.features['controlPoints'], true, 'features.controlPoints is missing');
  assert.equal(caps.static.features['releases'], true);
  assert.equal(caps.static.features['exposures'], true);
  assert.equal(caps.static.features['signals'], true);
  assert.equal(caps.static.features['inMemoryAdapter'], true);
  assert.equal(caps.static.openFeature.providerName, 'fireweave');
  assert.equal(caps.static.openFeature.specFloor, '0.8.0');
  assert.equal(caps.runtime.backend, 'inmemory');
  assert.equal(caps.runtime.lifecycle, 'READY');

  await client.shutdown();
});

test('every v2 capability string is still accepted by invokeCapability', async () => {
  const client = await readyClient();
  for (const capability of V2_CAPABILITIES) {
    const result = client.invokeCapability(capability);
    assert.equal(result.ok, true, `capability no longer accepted: ${capability}`);
  }
  await client.shutdown();
});

test('InMemoryAdapter still takes the `flags` option key', async () => {
  const runtime = new FireweaveRuntime(new InMemoryAdapter({ flags: { ...BOOL_FLAG } }));
  await runtime.initialize();
  const decision = await runtime.evaluate('new-checkout', 'boolean', false, {
    targetingKey: 'user_42',
  });
  assert.equal(decision.value, true);
  await runtime.shutdown();
});

test('the reported sdkVersion matches package.json — these drifted apart in v2', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifestPath = join(here, '..', '..', 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string };

  const client = await readyClient();
  assert.equal(
    client.capabilities.get().static.sdkVersion,
    manifest.version,
    'SDK_VERSION in client.ts must be bumped with package.json#version',
  );
  await client.shutdown();
});

test('capabilities.list still returns the v2 capability strings', async () => {
  const client = await readyClient();
  const listed = new Set(client.capabilities.list());
  const missing = V2_CAPABILITIES.filter((c) => !listed.has(c));
  assert.deepEqual(missing, [], `capability strings removed: ${missing.join(', ')}`);
  await client.shutdown();
});
