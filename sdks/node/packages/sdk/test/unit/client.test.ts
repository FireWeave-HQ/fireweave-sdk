import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FireweaveClient, FireweaveRuntime, InMemoryAdapter } from '@fireweaveai/sdk';

function makeClient(telemetry?: { attributeAllowlist?: readonly string[] }): {
  client: FireweaveClient;
  adapter: InMemoryAdapter;
} {
  const adapter = new InMemoryAdapter();
  const runtime = new FireweaveRuntime(adapter);
  const client = new FireweaveClient(runtime, telemetry !== undefined ? { telemetry } : {});
  return { client, adapter };
}

test('releases: setContext -> start -> complete records outcome signal', () => {
  const { client } = makeClient();
  const set = client.releases.setContext({
    stampIds: ['stamp_01HZX0000000000000000001'],
    rolloutId: 'rollout_01HZX0000000000000000001',
  });
  assert.equal(set.ok, true);
  assert.equal(client.releases.start().ok, true);
  const done = client.releases.complete();
  assert.equal(done.ok, true);
  assert.equal(done.status, 'completed');
  const outcomes = client.signals.getRecorded('outcome');
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.status, 'completed');
  assert.equal(outcomes[0]?.rolloutId, 'rollout_01HZX0000000000000000001');
});

test('releases: fail redacts secrets from reason', () => {
  const { client } = makeClient();
  client.releases.setContext({ stampIds: ['stamp_01HZX0000000000000000001'] });
  const failed = client.releases.fail({ reason: 'deploy hit phc_ABCDEF token error' });
  assert.equal(failed.ok, true);
  assert.equal(failed.status, 'failed');
  assert.ok(!String(failed.reason).includes('phc_ABCDEF'));
});

test('releases: operations without context degrade, never throw', () => {
  const { client } = makeClient();
  const res = client.releases.start();
  assert.equal(res.ok, false);
  assert.equal(res.errorKind, 'InvalidContext');
});

test('releases: setContext rejects empty stampIds', () => {
  const { client } = makeClient();
  const res = client.releases.setContext({ stampIds: [] });
  assert.equal(res.ok, false);
  assert.equal(res.errorKind, 'InvalidContext');
});

test('exposures: dedup by targetingKey+flagKey+variant+value', async () => {
  const { client, adapter } = makeClient();
  const exposure = { targetingKey: 'u1', flagKey: 'f', value: true, variant: 'on' };
  assert.equal(client.exposures.record(exposure).ok, true);
  const second = client.exposures.record({ ...exposure });
  assert.equal(second.deduped, true);
  assert.equal(client.exposures.queuedCount(), 1);
  // different variant is a distinct exposure
  client.exposures.record({ ...exposure, variant: 'off', value: false });
  assert.equal(client.exposures.queuedCount(), 2);
  const flushed = await client.exposures.flush();
  assert.equal(flushed.flushed, 2);
  assert.equal(client.exposures.queuedCount(), 0);
  assert.equal(adapter.getExposures().length, 2);
});

test('exposures: flush honors an already-aborted AbortSignal', async () => {
  const { client } = makeClient();
  client.exposures.record({ targetingKey: 'u', flagKey: 'f', value: 1 });
  const controller = new AbortController();
  controller.abort();
  const res = await client.exposures.flush(controller.signal);
  assert.equal(res.ok, false);
  assert.equal(res.errorKind, 'Timeout');
  assert.equal(client.exposures.queuedCount(), 1); // nothing lost
});

test('signals: all four kinds are recorded with their kind', () => {
  const { client } = makeClient();
  client.signals.recordHealth({ name: 'db', status: 'healthy' });
  client.signals.recordError({ name: 'ingest', errorKind: 'Network' });
  client.signals.recordMetric({ name: 'latency_ms', value: 12 });
  client.signals.recordOutcome({ name: 'release', status: 'completed' });
  assert.equal(client.signals.getRecorded('health').length, 1);
  assert.equal(client.signals.getRecorded('error').length, 1);
  assert.equal(client.signals.getRecorded('metric').length, 1);
  assert.equal(client.signals.getRecorded('outcome').length, 1);
});

test('signals: telemetry allowlist drops non-allowlisted attributes; strings are redacted', () => {
  const { client } = makeClient({ attributeAllowlist: ['region'] });
  const res = client.signals.recordMetric({
    name: 'checkout',
    value: 1,
    attributes: { region: 'eu', email: 'pii@example.com', note: 'token phc_LEAK' },
  });
  assert.equal(res.ok, true);
  const recorded = client.signals.getRecorded('metric')[0];
  assert.deepEqual(Object.keys(recorded?.attributes ?? {}), ['region']);
});

test('signals: message redaction applies without an allowlist', () => {
  const { client } = makeClient();
  client.signals.recordError({ name: 'auth', message: 'failed with Bearer secret.token.here' });
  const recorded = client.signals.getRecorded('error')[0];
  assert.ok(!String(recorded?.message).includes('secret.token.here'));
});

test('guardrails stub degrades with UnsupportedCapability, never throws', () => {
  const { client } = makeClient();
  const res = client.guardrails.evaluate('block-rollout');
  assert.equal(res.ok, false);
  assert.equal(res.errorKind, 'UnsupportedCapability');
  assert.equal(res.degraded, true);
});

test('invokeCapability degrades for unknown capability names', () => {
  const { client } = makeClient();
  const res = client.invokeCapability('time.travel');
  assert.equal(res.ok, false);
  assert.equal(res.errorKind, 'UnsupportedCapability');
  assert.equal(res.degraded, true);
  assert.equal(client.invokeCapability('signals.recordHealth').ok, true);
});

test('capabilities.get returns the full matrix with lifecycle state', async () => {
  const { client } = makeClient();
  const before = client.capabilities.get();
  assert.equal(before.runtime.lifecycle, 'UNINITIALIZED');
  await client.initialize();
  const caps = client.capabilities.get();
  assert.equal(caps.static.language, 'node');
  assert.equal(caps.static.openFeature.specFloor, '0.8.0');
  assert.equal(caps.static.features.guardrails, false);
  assert.equal(caps.runtime.backend, 'inmemory');
  assert.equal(caps.runtime.lifecycle, 'READY');
  assert.equal(caps.runtime.features?.localEvaluation, true);
});

test('client shutdown flushes exposures then shuts the runtime down', async () => {
  const { client, adapter } = makeClient();
  await client.initialize();
  client.exposures.record({ targetingKey: 'u', flagKey: 'f', value: true });
  await client.shutdown();
  assert.equal(adapter.getExposures().length, 1);
  assert.equal(adapter.isClosed(), true);
  assert.equal(client.runtime.getState(), 'SHUTDOWN');
});
