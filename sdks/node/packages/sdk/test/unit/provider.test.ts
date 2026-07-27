import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { OpenFeature, ProviderStatus } from '@openfeature/server-sdk';
import { FireweaveProvider, FireweaveRuntime, InMemoryAdapter } from '@fireweaveai/sdk';
import type { InMemoryFlagDefinition } from '@fireweaveai/sdk';

const FLAGS: Record<string, InMemoryFlagDefinition> = {
  'f-bool': { type: 'boolean', enabled: true, value: true, metadata: { version: 1 } },
  'f-string': { type: 'string', enabled: true, value: 'blue', variant: 'blue' },
  'f-int': { type: 'integer', enabled: true, value: 42 },
  'f-float': { type: 'float', enabled: true, value: 0.25 },
  'f-obj': { type: 'object', enabled: true, value: { retries: 3 } },
};

after(async () => {
  await OpenFeature.close();
});

test('provider registers with the OpenFeature SDK and reaches READY', async () => {
  const runtime = new FireweaveRuntime(new InMemoryAdapter({ flags: FLAGS }));
  const provider = new FireweaveProvider(runtime, { lazyReady: false });
  await OpenFeature.setProviderAndWait('unit-ready', provider);
  const client = OpenFeature.getClient('unit-ready');
  assert.equal(client.providerStatus, ProviderStatus.READY);
  assert.equal(provider.metadata.name, 'fireweave');
});

test('all resolver types return correct values and reasons', async () => {
  const runtime = new FireweaveRuntime(new InMemoryAdapter({ flags: FLAGS }));
  await OpenFeature.setProviderAndWait('unit-types', new FireweaveProvider(runtime, { lazyReady: false }));
  const client = OpenFeature.getClient('unit-types');
  const ctx = { targetingKey: 'user-1' };

  assert.equal(await client.getBooleanValue('f-bool', false, ctx), true);
  assert.equal(await client.getStringValue('f-string', 'red', ctx), 'blue');
  assert.equal(await client.getNumberValue('f-int', 0, ctx), 42);
  assert.equal(await client.getNumberValue('f-float', 0, ctx), 0.25);
  assert.deepEqual(await client.getObjectValue('f-obj', {}, ctx), { retries: 3 });

  const details = await client.getStringDetails('f-string', 'red', ctx);
  assert.equal(details.variant, 'blue');
  assert.equal(details.reason, 'TARGETING_MATCH');
  assert.equal(details.errorCode, undefined);

  const boolDetails = await client.getBooleanDetails('f-bool', false, ctx);
  assert.equal(boolDetails.flagMetadata['fireweave.flagVersion'], 1);
});

test('missing flag returns default with FLAG_NOT_FOUND, does not throw', async () => {
  const runtime = new FireweaveRuntime(new InMemoryAdapter({ flags: FLAGS }));
  await OpenFeature.setProviderAndWait('unit-missing', new FireweaveProvider(runtime, { lazyReady: false }));
  const client = OpenFeature.getClient('unit-missing');
  const details = await client.getBooleanDetails('nope', true, { targetingKey: 'u' });
  assert.equal(details.value, true);
  assert.equal(details.errorCode, 'FLAG_NOT_FOUND');
  assert.equal(details.reason, 'ERROR');
});

test('type mismatch returns default with TYPE_MISMATCH', async () => {
  const runtime = new FireweaveRuntime(new InMemoryAdapter({ flags: FLAGS }));
  await OpenFeature.setProviderAndWait('unit-tm', new FireweaveProvider(runtime, { lazyReady: false }));
  const client = OpenFeature.getClient('unit-tm');
  const details = await client.getBooleanDetails('f-string', false, { targetingKey: 'u' });
  assert.equal(details.value, false);
  assert.equal(details.errorCode, 'TYPE_MISMATCH');
});

test('domain scoping: two domains use independent providers', async () => {
  const rtA = new FireweaveRuntime(
    new InMemoryAdapter({ flags: { shared: { type: 'string', enabled: true, value: 'A' } } }),
  );
  const rtB = new FireweaveRuntime(
    new InMemoryAdapter({ flags: { shared: { type: 'string', enabled: true, value: 'B' } } }),
  );
  await OpenFeature.setProviderAndWait('domain-a', new FireweaveProvider(rtA, { lazyReady: false }));
  await OpenFeature.setProviderAndWait('domain-b', new FireweaveProvider(rtB, { lazyReady: false }));
  assert.equal(await OpenFeature.getClient('domain-a').getStringValue('shared', 'x', { targetingKey: 'u' }), 'A');
  assert.equal(await OpenFeature.getClient('domain-b').getStringValue('shared', 'x', { targetingKey: 'u' }), 'B');
});

test('invocation context overrides global (API-level) context', async () => {
  const flags: Record<string, InMemoryFlagDefinition> = {
    tiered: { type: 'string', enabled: true, value: 'gold', matchAttribute: { tier: 'gold' } },
  };
  const runtime = new FireweaveRuntime(new InMemoryAdapter({ flags }));
  await OpenFeature.setProviderAndWait('unit-ctx', new FireweaveProvider(runtime, { lazyReady: false }));
  runtime.setGlobalContext({ tier: 'bronze' });
  const client = OpenFeature.getClient('unit-ctx');
  // global tier=bronze does not match; invocation tier=gold wins
  assert.equal(
    await client.getStringValue('tiered', 'none', { targetingKey: 'u', tier: 'gold' }),
    'gold',
  );
  assert.equal(await client.getStringValue('tiered', 'none', { targetingKey: 'u' }), 'none');
});

test('provider close transitions runtime to SHUTDOWN', async () => {
  const runtime = new FireweaveRuntime(new InMemoryAdapter({ flags: FLAGS }));
  const provider = new FireweaveProvider(runtime, { lazyReady: false });
  await OpenFeature.setProviderAndWait('unit-close', provider);
  await provider.onClose();
  assert.equal(runtime.getState(), 'SHUTDOWN');
  const client = OpenFeature.getClient('unit-close');
  const details = await client.getBooleanDetails('f-bool', false, { targetingKey: 'u' });
  assert.equal(details.errorCode, 'PROVIDER_NOT_READY');
  assert.equal(details.flagMetadata['fireweave.errorKind'], 'AlreadyClosed');
});
