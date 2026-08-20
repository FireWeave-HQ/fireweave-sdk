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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FireweaveClient, FireweaveRuntime, InMemoryAdapter } from '@fireweaveai/sdk';
import * as sdk from '@fireweaveai/sdk';

const here = dirname(fileURLToPath(import.meta.url));
const SURFACE_DESCRIPTOR_PATH = join(
  here, '..', '..', '..', '..', '..', '..', 'conformance', 'surface', 'control-points.surface.json',
);

interface SurfaceMethod {
  readonly name: string;
  readonly args: readonly string[];
}
interface SurfaceDescriptor {
  readonly methods: readonly SurfaceMethod[];
}

const descriptor: SurfaceDescriptor = JSON.parse(readFileSync(SURFACE_DESCRIPTOR_PATH, 'utf8'));

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

test('every method matches the descriptor\'s arity exactly (conformance/surface/control-points.surface.json)', () => {
  // A method existing is not the same claim as a method matching the shape
  // the descriptor pins — `evaluate` carries the general form's fifth
  // `options?` parameter, the eight delegates carry exactly three. Reading
  // `args` from the descriptor (rather than hard-coding counts here) makes
  // this test track the descriptor instead of silently drifting from it.
  const cp = client().controlPoints as unknown as Record<string, (...args: unknown[]) => unknown>;
  assert.ok(descriptor.methods.length > 0, 'expected methods in the surface descriptor');

  const offenders: string[] = [];
  for (const method of descriptor.methods) {
    const fn = cp[method.name];
    if (typeof fn !== 'function') {
      offenders.push(`${method.name}: missing`);
      continue;
    }
    if (fn.length !== method.args.length) {
      offenders.push(`${method.name}: expected arity ${method.args.length} (${method.args.join(', ')}), got ${fn.length}`);
    }
  }
  assert.deepEqual(offenders, [], `arity mismatches: ${offenders.join('; ')}`);
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
