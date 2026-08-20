/**
 * Control-point SURFACE parity (spec/control-points.md, conformance/surface/).
 *
 * Behaviour is asserted elsewhere; this file asserts the surface EXISTS. That
 * distinction matters because a missing method is invisible: go shipped
 * `client.Flags()` with no ControlPoints namespace and python shipped
 * `get_integer_value` with no object variant, both unnoticed for months,
 * because nothing structurally forced seven independent implementations to
 * agree. A surface test turns silent divergence into a failing assertion.
 *
 * Per ADR-0010 it also pins the v1 scope boundary — the namespaces and the
 * OpenFeature provider that must NOT come back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FireweaveClient, FireweaveRuntime, InMemoryAdapter } from '@fireweaveai/sdk';
import * as sdk from '@fireweaveai/sdk';

const REQUIRED = [
  'getBooleanValue', 'getStringValue', 'getNumberValue', 'getObjectValue',
  'getBooleanDetails', 'getStringDetails', 'getNumberDetails', 'getObjectDetails',
  'evaluate',
] as const;

function client() {
  return new FireweaveClient(new FireweaveRuntime(new InMemoryAdapter({ flags: {} })));
}

test('controlPoints exposes all nine methods', () => {
  const cp = client().controlPoints as unknown as Record<string, unknown>;
  const missing = REQUIRED.filter((m) => typeof cp[m] !== 'function');
  assert.deepEqual(missing, [], `missing control-point methods: ${missing.join(', ')}`);
});

test('the deprecated flags alias shares identity with controlPoints', () => {
  const fw = client();
  assert.equal(fw.flags, fw.controlPoints);
});

test('*Details returns a Decision, *Value returns the bare value', async () => {
  const fw = client();
  const value = await fw.controlPoints.getBooleanValue('absent', false);
  const details = await fw.controlPoints.getBooleanDetails('absent', false);

  assert.equal(value, false);
  assert.equal(details.value, false);
  // The whole point of the pair: details carries what value cannot.
  assert.equal(details.flagKey, 'absent');
  assert.equal(typeof details.reason, 'string');
});

test('v1 scope: the cut namespaces and the OpenFeature provider are absent', () => {
  const fw = client() as unknown as Record<string, unknown>;
  for (const ns of ['releases', 'exposures', 'signals', 'capabilities', 'guardrails']) {
    assert.equal(fw[ns], undefined, `${ns} must not be exposed in v1 (ADR-0010)`);
  }
  for (const sym of ['FireweaveProvider', 'makeFireweaveLocalProvider']) {
    assert.equal(
      (sdk as unknown as Record<string, unknown>)[sym],
      undefined,
      `${sym} was retired in ADR-0010 and must not return without superseding it`,
    );
  }
});
