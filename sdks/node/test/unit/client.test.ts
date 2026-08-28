import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FireweaveClient, FireweaveRuntime, InMemoryAdapter } from '@fireweaveai/server-sdk';

/** Ready-state client (extension calls are lifecycle-gated per ruling 17). */
async function makeClient(): Promise<{
  client: FireweaveClient;
  adapter: InMemoryAdapter;
}> {
  const adapter = new InMemoryAdapter();
  const runtime = new FireweaveRuntime(adapter);
  await runtime.initialize();
  const client = new FireweaveClient(runtime);
  return { client, adapter };
}

test('invokeCapability degrades for unknown capability names', async () => {
  const { client } = await makeClient();
  const res = client.invokeCapability('time.travel');
  assert.equal(res.ok, false);
  assert.equal(res.errorKind, 'UnsupportedCapability');
  assert.equal(res.degraded, true);
});

test('invokeCapability degrades cut-namespace capability names, not { ok: true } (ADR-0010)', async () => {
  const { client } = await makeClient();
  // v1 scope is exactly control points + target registration
  // (spec/control-points.md): releases, exposures, signals, capabilities
  // discovery and guardrails MUST NOT be exposed, including through the
  // dynamic dispatcher — a cut capability name resolves exactly like any
  // other unknown string, never a fabricated success.
  for (const capability of [
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
  ]) {
    const res = client.invokeCapability(capability);
    assert.equal(res.ok, false, `${capability} must not resolve ok:true`);
    assert.equal(res.errorKind, 'UnsupportedCapability', `${capability} must degrade UnsupportedCapability`);
    assert.equal(res.degraded, true, `${capability} must be marked degraded`);
  }
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
