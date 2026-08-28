/**
 * Local-mode target registration (spec/modes.md).
 *
 * This reverses an earlier design in which the local adapter reported
 * `UnsupportedCapability`. That existed to stop a dev harness *silently*
 * looking registered — a developer believing their targeting works because
 * nothing objected, with the first evidence otherwise arriving in production.
 *
 * Recording plus an explicit trace keeps that guarantee by a different route:
 * nothing is silent, and local dev can exercise targeting rules offline. These
 * tests pin both halves — the recording AND the trace — because dropping the
 * trace would restore exactly the failure the old design was avoiding.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FireweaveLocalAdapter, FireweaveRuntime, FireweaveClient } from '@fireweaveai/server-sdk';

function harness() {
  const lines: string[] = [];
  const adapter = new FireweaveLocalAdapter({ log: (m) => lines.push(m) });
  return { adapter, lines };
}

test('records the target instead of reporting UnsupportedCapability', async () => {
  const { adapter } = harness();
  const runtime = new FireweaveRuntime(adapter);
  await runtime.initialize();

  const result = await runtime.registerTarget('user_42', {
    kind: 'user',
    properties: { plan: 'pro' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);

  const [recorded] = adapter.getRegisteredTargets();
  assert.equal(recorded?.targetingKey, 'user_42');
  assert.equal(recorded?.kind, 'user');
  assert.deepEqual(recorded?.properties, { plan: 'pro' });
});

test('traces the call, naming local mode and that nothing was sent', async () => {
  const { adapter, lines } = harness();
  const runtime = new FireweaveRuntime(adapter);
  await runtime.initialize();
  await runtime.registerTarget('user_7', { properties: { beta: true } });

  assert.equal(lines.length, 1);
  const [line] = lines;
  // Naming the mode is what makes a stray line in a production log a signal
  // that something booted locally by mistake.
  assert.match(line!, /\[fireweave:local\]/);
  assert.match(line!, /user_7/);
  assert.match(line!, /NOT sent to fw-server/);
});

test('kind defaults to user, and properties are copied not aliased', async () => {
  const { adapter } = harness();
  const runtime = new FireweaveRuntime(adapter);
  await runtime.initialize();

  const properties: Record<string, unknown> = { plan: 'free' };
  await runtime.registerTarget('user_9', { properties: properties as never });
  properties.plan = 'mutated-after-the-call';

  const [recorded] = adapter.getRegisteredTargets();
  assert.equal(recorded?.kind, 'user');
  assert.deepEqual(recorded?.properties, { plan: 'free' });
});

test('re-registering the same key updates rather than duplicating', async () => {
  const { adapter } = harness();
  const runtime = new FireweaveRuntime(adapter);
  await runtime.initialize();

  await runtime.registerTarget('user_1', { properties: { plan: 'free' } });
  await runtime.registerTarget('user_1', { properties: { plan: 'pro' } });

  const targets = adapter.getRegisteredTargets();
  assert.equal(targets.length, 1);
  assert.deepEqual(targets[0]?.properties, { plan: 'pro' });
});

test('the client surface reaches it too', async () => {
  const { adapter } = harness();
  const runtime = new FireweaveRuntime(adapter);
  await runtime.initialize();
  const fw = new FireweaveClient(runtime);

  const result = await fw.registerTarget('user_3', { properties: { region: 'eu' } });
  assert.equal(result.ok, true);
  assert.equal(adapter.getRegisteredTargets().length, 1);
});
