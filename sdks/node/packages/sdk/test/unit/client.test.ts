import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FireweaveClient, FireweaveRuntime, InMemoryAdapter } from '@fireweaveai/sdk';

/** Ready-state client (extension calls are lifecycle-gated per ruling 17). */
async function makeClient(telemetry?: { attributeAllowlist?: readonly string[] }): Promise<{
  client: FireweaveClient;
  adapter: InMemoryAdapter;
}> {
  const adapter = new InMemoryAdapter();
  const runtime = new FireweaveRuntime(adapter);
  await runtime.initialize();
  const client = new FireweaveClient(runtime, telemetry !== undefined ? { telemetry } : {});
  return { client, adapter };
}

const VALID_STAMP = 'stmp_01HZXRE0000000000000000001';
const VALID_ROLLOUT = 'rollout_01HZX0000000000000000001';

test('releases: setContext -> start -> complete records outcome signal', async () => {
  const { client } = await makeClient();
  const set = client.releases.setContext({
    stampIds: [VALID_STAMP],
    rolloutId: VALID_ROLLOUT,
  });
  assert.equal(set.ok, true);
  assert.equal(client.releases.start().ok, true);
  const done = client.releases.complete();
  assert.equal(done.ok, true);
  assert.equal(done.status, 'completed');
  const outcomes = client.signals.getRecorded('outcome');
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.status, 'completed');
  assert.equal(outcomes[0]?.rolloutId, VALID_ROLLOUT);
});

test('releases: fail redacts secrets from reason', async () => {
  const { client } = await makeClient();
  client.releases.setContext({
    rolloutId: VALID_ROLLOUT,
    stampIds: [VALID_STAMP],
  });
  const failed = client.releases.fail({ reason: 'deploy hit phc_ABCDEF token error' });
  assert.equal(failed.ok, true);
  assert.equal(failed.status, 'failed');
  assert.ok(!String(failed.reason).includes('phc_ABCDEF'));
});

test('releases: operations without context degrade, never throw', async () => {
  const { client } = await makeClient();
  const res = client.releases.start();
  assert.equal(res.ok, false);
  assert.equal(res.errorKind, 'InvalidContext');
});

test('releases: setContext rejects empty stampIds', async () => {
  const { client } = await makeClient();
  const res = client.releases.setContext({ rolloutId: 'rollout_x', stampIds: [] });
  assert.equal(res.ok, false);
  assert.equal(res.errorKind, 'InvalidContext');
});

test('releases: setContext requires rolloutId (ruling 15)', async () => {
  const { client } = await makeClient();
  const res = client.releases.setContext({
    stampIds: [VALID_STAMP],
  } as unknown as Parameters<typeof client.releases.setContext>[0]);
  assert.equal(res.ok, false);
  assert.equal(res.errorKind, 'InvalidContext');
});

test('H-2: setContext rejects stamp_ prefix and malformed ULIDs', async () => {
  const { client } = await makeClient();
  const badPrefix = client.releases.setContext({
    rolloutId: VALID_ROLLOUT,
    stampIds: ['stamp_01HZX0000000000000000001'],
  });
  assert.equal(badPrefix.ok, false);
  assert.equal(badPrefix.errorKind, 'InvalidContext');

  const badLength = client.releases.setContext({
    rolloutId: VALID_ROLLOUT,
    stampIds: ['stmp_01HZX0000000000000000000001'], // 27 chars after prefix
  });
  assert.equal(badLength.ok, false);
  assert.equal(badLength.errorKind, 'InvalidContext');

  const badChange = client.releases.setContext({
    rolloutId: VALID_ROLLOUT,
    stampIds: [VALID_STAMP],
    changeId: 'change_not_a_ulid',
  });
  assert.equal(badChange.ok, false);
  assert.equal(badChange.errorKind, 'InvalidContext');

  const dupStamps = client.releases.setContext({
    rolloutId: VALID_ROLLOUT,
    stampIds: [VALID_STAMP, VALID_STAMP],
  });
  assert.equal(dupStamps.ok, false);
  assert.equal(dupStamps.errorKind, 'InvalidContext');
});

test('exposures: dedup by targetingKey+flagKey+variant+value', async () => {
  const { client, adapter } = await makeClient();
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
  const { client } = await makeClient();
  client.exposures.record({ targetingKey: 'u', flagKey: 'f', value: 1 });
  const controller = new AbortController();
  controller.abort();
  const res = await client.exposures.flush(controller.signal);
  assert.equal(res.ok, false);
  assert.equal(res.errorKind, 'Timeout');
  assert.equal(client.exposures.queuedCount(), 1); // nothing lost
});

test('signals: all four kinds are recorded with their kind', async () => {
  const { client } = await makeClient();
  client.signals.recordHealth({ name: 'db', status: 'healthy' });
  client.signals.recordError({ name: 'ingest', errorKind: 'Network' });
  client.signals.recordMetric({ name: 'latency_ms', value: 12 });
  client.signals.recordOutcome({ name: 'release', status: 'completed' });
  assert.equal(client.signals.getRecorded('health').length, 1);
  assert.equal(client.signals.getRecorded('error').length, 1);
  assert.equal(client.signals.getRecorded('metric').length, 1);
  assert.equal(client.signals.getRecorded('outcome').length, 1);
});

test('signals: telemetry allowlist drops non-allowlisted attributes; strings are redacted', async () => {
  const { client } = await makeClient({ attributeAllowlist: ['region'] });
  const res = client.signals.recordMetric({
    name: 'checkout',
    value: 1,
    attributes: { region: 'eu', email: 'pii@example.com', note: 'token phc_LEAK' },
  });
  assert.equal(res.ok, true);
  const recorded = client.signals.getRecorded('metric')[0];
  assert.deepEqual(Object.keys(recorded?.attributes ?? {}), ['region']);
});

test('signals: message redaction applies without an allowlist', async () => {
  const { client } = await makeClient();
  client.signals.recordError({ name: 'auth', message: 'failed with Bearer secret.token.here' });
  const recorded = client.signals.getRecorded('error')[0];
  assert.ok(!String(recorded?.message).includes('secret.token.here'));
});

test('guardrails stub degrades with UnsupportedCapability, never throws', async () => {
  const { client } = await makeClient();
  const res = client.guardrails.evaluate('block-rollout');
  assert.equal(res.ok, false);
  assert.equal(res.errorKind, 'UnsupportedCapability');
  assert.equal(res.degraded, true);
});

test('invokeCapability degrades for unknown capability names', async () => {
  const { client } = await makeClient();
  const res = client.invokeCapability('time.travel');
  assert.equal(res.ok, false);
  assert.equal(res.errorKind, 'UnsupportedCapability');
  assert.equal(res.degraded, true);
  assert.equal(client.invokeCapability('signals.recordHealth').ok, true);
});

test('capabilities.get returns the full matrix with lifecycle state', async () => {
  // Built by hand (not makeClient) so the pre-init lifecycle is observable.
  const client = new FireweaveClient(new FireweaveRuntime(new InMemoryAdapter()));
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

test('exposures: dedup window is one flush cycle (seen-set cleared on flush)', async () => {
  const { client, adapter } = await makeClient();
  const exposure = { targetingKey: 'u1', flagKey: 'f', value: true, variant: 'on' };
  assert.equal(client.exposures.record(exposure).ok, true);
  assert.equal(client.exposures.record({ ...exposure }).deduped, true);
  const first = await client.exposures.flush();
  assert.equal(first.flushed, 1);
  // After flush the same tuple is a fresh exposure — the dedup set must not
  // grow without bound across flush windows (M-2, Python's lifecycle).
  const again = client.exposures.record({ ...exposure });
  assert.equal(again.ok, true);
  assert.notEqual(again.deduped, true);
  assert.equal(client.exposures.queuedCount(), 1);
  await client.exposures.flush();
  assert.equal(adapter.getExposures().length, 2);
});

test('signals: default telemetry allowlist is ON (canonical keys only)', async () => {
  const { client } = await makeClient();
  const res = client.signals.recordMetric({
    name: 'checkout',
    value: 1,
    attributes: {
      service: 'checkout-api', // canonical → kept
      environment: 'prod', // canonical → kept
      email: 'pii@example.com', // not allowlisted → dropped
      creditCard: '4111-1111-1111-1111', // not allowlisted → dropped
    },
  });
  assert.equal(res.ok, true);
  const recorded = client.signals.getRecorded('metric')[0];
  assert.deepEqual(Object.keys(recorded?.attributes ?? {}).sort(), ['environment', 'service']);
});

test('signals are delivered to the adapter sink (ruling 17)', async () => {
  const { client, adapter } = await makeClient();
  client.signals.recordHealth({ name: 'db', status: 'healthy' });
  client.signals.recordError({ name: 'ingest', errorKind: 'Network', message: 'phc_SECRET leak?' });
  const sunk = adapter.getSignals();
  assert.equal(sunk.length, 2);
  assert.equal(sunk[0]?.kind, 'health');
  assert.equal(sunk[1]?.kind, 'error');
  // Redaction applies before sink delivery.
  assert.ok(!String(sunk[1]?.message).includes('phc_SECRET'));
});

test('extension calls before READY degrade with UnsupportedCapability, never throw', async () => {
  const client = new FireweaveClient(new FireweaveRuntime(new InMemoryAdapter()));
  const release = client.releases.setContext({
    rolloutId: 'rollout_x',
    stampIds: [VALID_STAMP],
  });
  assert.equal(release.ok, false);
  assert.equal(release.errorKind, 'UnsupportedCapability');
  assert.equal(release.degraded, true);
  const exposure = client.exposures.record({ targetingKey: 'u', flagKey: 'f', value: true });
  assert.equal(exposure.ok, false);
  assert.equal(exposure.errorKind, 'UnsupportedCapability');
  const flush = await client.exposures.flush();
  assert.equal(flush.ok, false);
  assert.equal(flush.errorKind, 'UnsupportedCapability');
  const signal = client.signals.recordHealth({ name: 'db', status: 'healthy' });
  assert.equal(signal.ok, false);
  assert.equal(signal.errorKind, 'UnsupportedCapability');
  assert.equal(signal.degraded, true);
  const invoked = client.invokeCapability('signals.recordHealth');
  assert.equal(invoked.ok, false);
  assert.equal(invoked.errorKind, 'UnsupportedCapability');
});

test('extension calls after shutdown degrade with AlreadyClosed, never throw', async () => {
  const { client } = await makeClient();
  client.releases.setContext({
    rolloutId: 'rollout_x',
    stampIds: [VALID_STAMP],
  });
  await client.shutdown();
  const release = client.releases.start();
  assert.equal(release.ok, false);
  assert.equal(release.errorKind, 'AlreadyClosed');
  assert.equal(release.degraded, true);
  const exposure = client.exposures.record({ targetingKey: 'u', flagKey: 'f', value: true });
  assert.equal(exposure.ok, false);
  assert.equal(exposure.errorKind, 'AlreadyClosed');
  const flush = await client.exposures.flush();
  assert.equal(flush.ok, false);
  assert.equal(flush.errorKind, 'AlreadyClosed');
  const signal = client.signals.recordMetric({ name: 'latency_ms', value: 1 });
  assert.equal(signal.ok, false);
  assert.equal(signal.errorKind, 'AlreadyClosed');
  assert.equal(signal.degraded, true);
});

test('flags.evaluate exposes detailed Decision evaluation on the client surface', async () => {
  const adapter = new InMemoryAdapter({
    flags: {
      'fw-detail': {
        type: 'string',
        enabled: true,
        value: 'midnight',
        variant: 'midnight',
        metadata: { version: 7 },
      },
    },
  });
  const runtime = new FireweaveRuntime(adapter);
  await runtime.initialize();
  const client = new FireweaveClient(runtime);
  const decision = await client.flags.evaluate('fw-detail', 'string', 'classic', {
    targetingKey: 'user-1',
  });
  assert.equal(decision.value, 'midnight');
  assert.equal(decision.variant, 'midnight');
  assert.equal(decision.reason, 'TARGETING_MATCH');
  assert.equal(decision.metadata['fireweave.flagVersion'], 7);
  // Errors surface as decisions, never throws:
  const missing = await client.flags.evaluate('nope', 'boolean', false);
  assert.equal(missing.reason, 'ERROR');
  assert.equal(missing.errorKind, 'FlagNotFound');
  // Typed conveniences ride on the same path.
  assert.equal(await client.flags.getStringValue('fw-detail', 'classic'), 'midnight');
});

test('client shutdown flushes exposures then shuts the runtime down', async () => {
  const { client, adapter } = await makeClient();
  await client.initialize();
  client.exposures.record({ targetingKey: 'u', flagKey: 'f', value: true });
  await client.shutdown();
  assert.equal(adapter.getExposures().length, 1);
  assert.equal(adapter.isClosed(), true);
  assert.equal(client.runtime.getState(), 'SHUTDOWN');
});
