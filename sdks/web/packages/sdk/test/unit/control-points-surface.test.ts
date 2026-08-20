/**
 * Control-point SURFACE parity (spec/control-points.md,
 * conformance/surface/control-points.surface.json), mirroring
 * sdks/node/packages/sdk/test/unit/control-points-surface.test.ts.
 *
 * Behaviour is asserted elsewhere; this file asserts the surface EXISTS.
 * That distinction matters because a missing method is invisible: nothing
 * structurally forces seven independent implementations to agree. A surface
 * test turns silent divergence into a failing assertion.
 *
 * It also pins the v1 scope boundary — the namespaces and the OpenFeature
 * provider that must NOT come back — and web's own gaps from the plan's
 * table: the four `*Details` methods and local-mode `registerTarget`.
 *
 * One divergence from node, and it is the ADR-0009 contract, not an
 * oversight: every method here is SYNCHRONOUS. Node's file awaits each
 * call; this one does not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FireweaveLocalWebAdapter,
  FireweaveWebClient,
  FireweaveWebRuntime,
  InMemoryWebAdapter,
} from '@fireweaveai/web-sdk';
import type { WebBackendAdapter } from '@fireweaveai/web-sdk';
import * as sdk from '@fireweaveai/web-sdk';

const REQUIRED = [
  'getBooleanValue',
  'getStringValue',
  'getNumberValue',
  'getObjectValue',
  'getBooleanDetails',
  'getStringDetails',
  'getNumberDetails',
  'getObjectDetails',
  'evaluate',
] as const;

function client(adapter: WebBackendAdapter = new InMemoryWebAdapter({ flags: {} })) {
  return new FireweaveWebClient(new FireweaveWebRuntime(adapter));
}

async function readyClient(adapter: WebBackendAdapter = new InMemoryWebAdapter({ flags: {} })) {
  const fw = client(adapter);
  await fw.initialize({ targetingKey: 'user-1' });
  return fw;
}

test('controlPoints exposes all nine methods', async () => {
  const fw = await readyClient();
  const cp = fw.controlPoints as unknown as Record<string, unknown>;
  const missing = REQUIRED.filter((m) => typeof cp[m] !== 'function');
  assert.deepEqual(missing, [], `missing control-point methods: ${missing.join(', ')}`);
});

test('the deprecated flags alias shares identity with controlPoints', async () => {
  const fw = await readyClient();
  assert.equal(fw.flags, fw.controlPoints);
});

test('*Details returns a Decision, *Value returns the bare value', async () => {
  const fw = await readyClient();

  const value = fw.controlPoints.getBooleanValue('absent', false);
  const details = fw.controlPoints.getBooleanDetails('absent', false);

  assert.equal(value, false);
  assert.equal(details.value, false);
  // The whole point of the pair: details carries what value cannot.
  assert.equal(details.flagKey, 'absent');
  assert.equal(typeof details.reason, 'string');
});

test('every read is SYNCHRONOUS — no method here returns a Promise (ADR-0009)', async () => {
  const fw = await readyClient(
    new InMemoryWebAdapter({ flags: { on: { type: 'boolean', enabled: true, value: true } } })
  );
  const results: unknown[] = [
    fw.controlPoints.getBooleanValue('on', false),
    fw.controlPoints.getStringValue('absent', 'x'),
    fw.controlPoints.getNumberValue('absent', 1),
    fw.controlPoints.getObjectValue('absent', {}),
    fw.controlPoints.getBooleanDetails('on', false),
    fw.controlPoints.getStringDetails('absent', 'x'),
    fw.controlPoints.getNumberDetails('absent', 1),
    fw.controlPoints.getObjectDetails('absent', {}),
    fw.controlPoints.evaluate('on', 'boolean', false),
  ];
  for (const r of results) {
    assert.equal(r instanceof Promise, false);
  }
});

test('v1 scope: the cut namespaces and the OpenFeature provider are absent', async () => {
  const fw = (await readyClient()) as unknown as Record<string, unknown>;
  for (const ns of ['releases', 'exposures', 'signals', 'capabilities', 'guardrails']) {
    assert.equal(fw[ns], undefined, `${ns} must not be exposed in v1 (spec/control-points.md "Scope of v1")`);
  }
  for (const sym of ['FireweaveProvider', 'FireweaveWebProvider', 'makeFireweaveLocalProvider']) {
    assert.equal(
      (sdk as unknown as Record<string, unknown>)[sym],
      undefined,
      `${sym} must not be exposed — v1 has no OpenFeature provider on this package`
    );
  }
});

test('registerTarget: local mode records in-process and traces, never sends to fw-server', async () => {
  const lines: string[] = [];
  const adapter = new FireweaveLocalWebAdapter({ log: (m) => lines.push(m) });
  const fw = client(adapter);
  await fw.initialize();

  const result = await fw.registerTarget('user-9', { properties: { plan: 'pro' } });
  assert.equal(result.ok, true);

  const [recorded] = adapter.getRegisteredTargets();
  assert.equal(recorded?.targetingKey, 'user-9');
  assert.deepEqual(recorded?.properties, { plan: 'pro' });

  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /\[fireweave:local\]/);
  assert.match(lines[0]!, /NOT sent to fw-server/);
});

test('registerTarget resolves rather than raising, in both modes', async () => {
  const fw = await readyClient();
  await assert.doesNotReject(() => fw.registerTarget('user-1'));
});
