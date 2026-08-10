import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenFeature } from '@openfeature/server-sdk';
import type { JsonValue, Logger, Provider } from '@openfeature/server-sdk';
import {
  FireweaveLocalAdapter,
  FireweaveRuntime,
  getFwLocalCaptures,
  makeFireweaveLocalProvider,
  resetFwLocalCaptures,
} from '@fireweaveai/sdk';

/**
 * The local dev provider exists to give the harness's DEV branch a clean
 * "reads return the call-site default" contract (RAMP-1), while still routing
 * through FireweaveRuntime so dev and prod share lifecycle gating and context
 * canonicalization.
 *
 * The load-bearing behaviour is the not-found rewrite: the runtime turns an
 * adapter miss into an ERROR decision with FLAG_NOT_FOUND (pinned across all
 * four languages by contracts/evaluation/eval-missing-flag-default.json), which
 * is correct for a real backend and wrong for a dev substrate where "no flag
 * configured" is the normal case, not an error.
 */

const ctx = { targetingKey: 'user_42' };

/** The OpenFeature SDK always passes a logger; the provider ignores it. */
const LOGGER: Logger = { error() {}, warn() {}, info() {}, debug() {} };

async function provider(opts: Parameters<typeof makeFireweaveLocalProvider>[0] = {}) {
  const p = makeFireweaveLocalProvider(opts);
  await p.initialize?.({});
  return p;
}

// Thin call helpers so each assertion reads as the evaluation it is testing
// rather than as a four-argument provider invocation.
const evalBool = (p: Provider, key: string, dflt: boolean) =>
  p.resolveBooleanEvaluation(key, dflt, ctx, LOGGER);
const evalString = (p: Provider, key: string, dflt: string) =>
  p.resolveStringEvaluation(key, dflt, ctx, LOGGER);
const evalNumber = (p: Provider, key: string, dflt: number) =>
  p.resolveNumberEvaluation(key, dflt, ctx, LOGGER);
const evalObject = <T extends JsonValue>(p: Provider, key: string, dflt: T) =>
  p.resolveObjectEvaluation<T>(key, dflt, ctx, LOGGER);

test('unknown control point resolves to the call-site default, cleanly', async () => {
  resetFwLocalCaptures();
  const p = await provider();
  const d = await evalBool(p, 'fw-unconfigured', false);

  assert.equal(d.value, false);
  assert.equal(d.reason, 'DEFAULT');
  assert.equal(d.errorCode, undefined, 'a dev miss must not surface as an error');
  assert.equal(d.variant, 'default');
});

test('the call-site default is honoured, not coerced to false', async () => {
  const p = await provider();
  const d = await evalBool(p, 'fw-unconfigured', true);
  assert.equal(d.value, true);
  assert.equal(d.reason, 'DEFAULT');
  assert.equal(d.errorCode, undefined);
});

test('devFlags true turns a control point ON with reason STATIC', async () => {
  const p = await provider({ devFlags: { 'fw-checkout': true } });
  const d = await evalBool(p, 'fw-checkout', false);

  assert.equal(d.value, true);
  assert.equal(d.reason, 'STATIC');
  assert.equal(d.variant, 'on');
  assert.equal(d.errorCode, undefined);
});

test('devFlags false forces the OFF branch even when the call site defaults true', async () => {
  const p = await provider({ devFlags: { 'fw-checkout': false } });
  const d = await evalBool(p, 'fw-checkout', true);

  assert.equal(d.value, false);
  assert.equal(d.reason, 'STATIC');
  assert.equal(d.variant, 'off');
});

test('string / number / object reads return their defaults cleanly', async () => {
  const p = await provider();

  const s = await evalString(p, 'fw-copy', 'fallback');
  assert.equal(s.value, 'fallback');
  assert.equal(s.reason, 'DEFAULT');
  assert.equal(s.errorCode, undefined);

  const n = await evalNumber(p, 'fw-limit', 7);
  assert.equal(n.value, 7);
  assert.equal(n.reason, 'DEFAULT');
  assert.equal(n.errorCode, undefined);

  const o = await evalObject(p, 'fw-config', { a: 1 });
  assert.deepEqual(o.value, { a: 1 });
  assert.equal(o.reason, 'DEFAULT');
  assert.equal(o.errorCode, undefined);
});

test('captures record every evaluation, and reset clears them', async () => {
  resetFwLocalCaptures();
  const p = await provider({ devFlags: { 'fw-on': true }, now: () => 1234 });

  await evalBool(p, 'fw-on', false);
  await evalString(p, 'fw-copy', 'x');

  const caps = getFwLocalCaptures();
  assert.equal(caps.length, 2);
  assert.deepEqual(
    caps.map((c) => [c.flagKey, c.type, c.value, c.reason, c.ts]),
    [
      ['fw-on', 'boolean', true, 'STATIC', 1234],
      ['fw-copy', 'string', 'x', 'DEFAULT', 1234],
    ]
  );

  resetFwLocalCaptures();
  assert.equal(getFwLocalCaptures().length, 0);
});

test('echo prints one line per evaluation when enabled', async () => {
  resetFwLocalCaptures();
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(' '));
  };
  try {
    const p = await provider({ echo: true, devFlags: { 'fw-on': true } });
    await evalBool(p, 'fw-on', false);
  } finally {
    console.log = original;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0] as string, /fw-local/);
  assert.match(lines[0] as string, /fw-on/);
});

test('echo stays silent by default', async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(' '));
  };
  try {
    const p = await provider();
    await evalBool(p, 'fw-quiet', false);
  } finally {
    console.log = original;
  }
  assert.equal(lines.length, 0);
});

test('REAL errors are NOT rewritten — only FLAG_NOT_FOUND is', async () => {
  const p = await provider();
  await p.onClose?.();

  // Evaluating after close is a genuine defect and must keep surfacing as one;
  // swallowing it would make a dead provider look like a working dev default.
  const d = await evalBool(p, 'fw-anything', false);
  assert.equal(d.reason, 'ERROR');
  assert.notEqual(d.errorCode, undefined);
});

test('the adapter reports a local-only, non-networked backend', async () => {
  const adapter = new FireweaveLocalAdapter({ devFlags: { a: true } });
  const f = adapter.features();
  assert.equal(f.localOnly, true);
  assert.equal(f.remoteEvaluation, false);
  assert.equal(f.sideEffectFreeReads, true);
});

test('the adapter misses on an unconfigured key and hits on a devFlag', async () => {
  const adapter = new FireweaveLocalAdapter({ devFlags: { 'fw-on': true } });
  await adapter.initialize();
  const canonical = { targetingKey: 'u', attributes: {} } as never;

  assert.deepEqual(await adapter.resolve('fw-missing', canonical), { found: false });

  const hit = await adapter.resolve('fw-on', canonical);
  assert.equal(hit.found, true);
  assert.equal(hit.value, true);
  assert.equal(hit.reason, 'STATIC');
});

test('composes with FireweaveRuntime like any other adapter', async () => {
  const runtime = new FireweaveRuntime(new FireweaveLocalAdapter({ devFlags: { 'fw-on': true } }));
  await runtime.initialize();
  assert.equal(runtime.getState(), 'READY');
  const d = await runtime.evaluate('fw-on', 'boolean', false, ctx, {});
  assert.equal(d.value, true);
  assert.equal(d.reason, 'STATIC');
  await runtime.shutdown();
});

test('works through the real OpenFeature client', async () => {
  resetFwLocalCaptures();
  await OpenFeature.setProviderAndWait(
    'local-dev-test',
    makeFireweaveLocalProvider({ devFlags: { 'fw-on': true } })
  );
  const client = OpenFeature.getClient('local-dev-test');

  assert.equal(await client.getBooleanValue('fw-on', false, ctx), true);
  assert.equal(await client.getBooleanValue('fw-unconfigured', false, ctx), false);

  const details = await client.getBooleanDetails('fw-unconfigured', true, ctx);
  assert.equal(details.value, true);
  assert.equal(details.reason, 'DEFAULT');
  assert.equal(details.errorCode, undefined);

  await OpenFeature.close();
});
