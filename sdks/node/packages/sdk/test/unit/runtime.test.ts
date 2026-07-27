import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FireweaveRuntime, InMemoryAdapter, FireweaveError, stableStringify } from '@fireweaveai/sdk';
import type {
  BackendAdapter,
  AdapterResolution,
  CanonicalContext,
  InMemoryFlagDefinition,
} from '@fireweaveai/sdk';

function adapterWith(flags: Record<string, InMemoryFlagDefinition>): InMemoryAdapter {
  return new InMemoryAdapter({ flags });
}

const BOOL_ON: Record<string, InMemoryFlagDefinition> = {
  'fw-a': { type: 'boolean', enabled: true, value: true },
};

test('lifecycle: UNINITIALIZED -> INITIALIZING -> READY -> SHUTDOWN', async () => {
  const runtime = new FireweaveRuntime(adapterWith(BOOL_ON));
  const seen: string[] = [];
  runtime.onStateChange((s) => seen.push(s));
  assert.equal(runtime.getState(), 'UNINITIALIZED');
  await runtime.initialize();
  assert.equal(runtime.getState(), 'READY');
  await runtime.shutdown();
  assert.equal(runtime.getState(), 'SHUTDOWN');
  assert.deepEqual(seen, ['INITIALIZING', 'READY', 'SHUTDOWN']);
});

test('evaluate before initialize returns NotReady decision, never throws', async () => {
  const runtime = new FireweaveRuntime(adapterWith(BOOL_ON));
  const decision = await runtime.evaluate('fw-a', 'boolean', false);
  assert.equal(decision.value, false);
  assert.equal(decision.reason, 'ERROR');
  assert.equal(decision.errorCode, 'PROVIDER_NOT_READY');
  assert.equal(decision.metadata['fireweave.errorKind'], 'NotReady');
});

test('evaluate after shutdown returns AlreadyClosed mapped to PROVIDER_NOT_READY', async () => {
  const runtime = new FireweaveRuntime(adapterWith(BOOL_ON));
  await runtime.initialize();
  await runtime.shutdown();
  const decision = await runtime.evaluate('fw-a', 'boolean', false);
  assert.equal(decision.errorKind, 'AlreadyClosed');
  assert.equal(decision.errorCode, 'PROVIDER_NOT_READY');
});

test('initialize after shutdown rejects with AlreadyClosed', async () => {
  const runtime = new FireweaveRuntime(adapterWith(BOOL_ON));
  await runtime.initialize();
  await runtime.shutdown();
  await assert.rejects(
    () => runtime.initialize(),
    (err: unknown) => err instanceof FireweaveError && err.kind === 'AlreadyClosed',
  );
});

test('shutdown is idempotent and flushes the adapter once per call', async () => {
  let flushes = 0;
  let shutdowns = 0;
  const adapter: BackendAdapter = {
    name: 'other',
    initialize: async () => {},
    resolve: async (): Promise<AdapterResolution> => ({ found: false }),
    flush: async () => {
      flushes += 1;
    },
    shutdown: async () => {
      shutdowns += 1;
    },
    features: () => ({}),
  };
  const runtime = new FireweaveRuntime(adapter);
  await runtime.initialize();
  await runtime.shutdown();
  await runtime.shutdown();
  assert.equal(flushes, 1);
  assert.equal(shutdowns, 1);
});

test('invalid config (bad host) puts runtime in FATAL and later evaluations return Configuration errors', async () => {
  const runtime = new FireweaveRuntime(adapterWith(BOOL_ON), { host: 'not-a-url' });
  await assert.rejects(
    () => runtime.initialize(),
    (err: unknown) => err instanceof FireweaveError && err.kind === 'Configuration',
  );
  assert.equal(runtime.getState(), 'FATAL');
  const decision = await runtime.evaluate('fw-a', 'boolean', false);
  assert.equal(decision.errorKind, 'Configuration');
});

test('adapter initialize failure -> ERROR state; NotReady decisions', async () => {
  const adapter: BackendAdapter = {
    name: 'other',
    initialize: async () => {
      throw new FireweaveError('BackendUnavailable');
    },
    resolve: async (): Promise<AdapterResolution> => ({ found: false }),
    shutdown: async () => {},
    features: () => ({}),
  };
  const runtime = new FireweaveRuntime(adapter);
  await assert.rejects(() => runtime.initialize());
  assert.equal(runtime.getState(), 'ERROR');
  const decision = await runtime.evaluate('anything', 'boolean', true);
  assert.equal(decision.errorKind, 'NotReady');
  assert.equal(decision.value, true);
});

test('type mismatch produces TYPE_MISMATCH with default value', async () => {
  const runtime = new FireweaveRuntime(
    adapterWith({ 'fw-s': { type: 'string', enabled: true, value: 'hello' } }),
  );
  await runtime.initialize();
  const decision = await runtime.evaluate('fw-s', 'boolean', false);
  assert.equal(decision.errorCode, 'TYPE_MISMATCH');
  assert.equal(decision.value, false);
});

test('unknown flag produces FLAG_NOT_FOUND', async () => {
  const runtime = new FireweaveRuntime(adapterWith(BOOL_ON));
  await runtime.initialize();
  const decision = await runtime.evaluate('missing', 'boolean', false);
  assert.equal(decision.errorCode, 'FLAG_NOT_FOUND');
  assert.equal(decision.errorKind, 'FlagNotFound');
});

test('adapter throw surfaces mapped error decision without throwing', async () => {
  const adapter: BackendAdapter = {
    name: 'other',
    initialize: async () => {},
    resolve: async () => {
      throw new FireweaveError('Network', { message: 'connection refused to phc_SECRET' });
    },
    shutdown: async () => {},
    features: () => ({}),
  };
  const runtime = new FireweaveRuntime(adapter);
  await runtime.initialize();
  const decision = await runtime.evaluate('fw-a', 'boolean', false);
  assert.equal(decision.errorKind, 'Network');
  assert.ok(!String(decision.errorMessage).includes('phc_SECRET'));
});

test('merge order: global -> client -> invocation is honored in resolveContext', async () => {
  const runtime = new FireweaveRuntime(adapterWith(BOOL_ON));
  await runtime.initialize();
  runtime.setGlobalContext({ targetingKey: 'g', tier: 'global', env: 'prod' });
  runtime.setClientContext({ tier: 'client' });
  const ctx: CanonicalContext = runtime.resolveContext({ targetingKey: 'i', env: 'staging' });
  assert.equal(ctx.targetingKey, 'i');
  assert.equal(ctx.attributes.tier, 'client');
  assert.equal(ctx.attributes.env, 'staging');
});

test('stableStringify sorts keys deterministically at every level', () => {
  assert.equal(
    stableStringify({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } }),
    '{"a":{"c":3,"d":[2,{"y":2,"z":1}]},"b":1}',
  );
});
