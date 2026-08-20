import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FireweaveError,
  FireweaveLocalWebAdapter,
  FireweaveRemoteWebAdapter,
  FireweaveWebClient,
  FireweaveWebRuntime,
  InMemoryWebAdapter,
  assertNotSecretKey,
} from '@fireweaveai/web-sdk';
import type { WebBackendAdapter } from '@fireweaveai/web-sdk';

const CTX = { targetingKey: 'user_42' };

const flagsAdapter = () =>
  new InMemoryWebAdapter({
    flags: {
      'new-checkout': { type: 'boolean', enabled: true, value: true, variant: 'on' },
      copy: { type: 'string', enabled: true, value: 'treatment' },
    },
  });

async function readyRuntime(adapter: WebBackendAdapter = flagsAdapter()) {
  const runtime = new FireweaveWebRuntime(adapter, { globalContext: CTX });
  await runtime.initialize();
  return runtime;
}

// ── the sync invariant ──────────────────────────────────────────────────────

test('controlPoints reads return values, NOT Promises', async () => {
  // The load-bearing web contract (ADR-0009): call sites read control points
  // without `await`, inside render paths where awaiting is impossible. This
  // used to be asserted through FireweaveWebProvider; the provider was retired
  // in ADR-0010, but the invariant it guarded is a property of the RUNTIME —
  // prefetch is async, evaluation is a pure synchronous cache read — so the
  // assertion moves to the control-point surface rather than being deleted.
  const fw = new FireweaveWebClient(await readyRuntime());

  const on = fw.controlPoints.getBooleanValue('new-checkout', false, CTX);
  assert.equal((on as unknown) instanceof Promise, false);
  assert.equal(on, true);

  for (const r of [
    fw.controlPoints.getStringValue('copy', 'x', CTX),
    fw.controlPoints.getNumberValue('absent', 1, CTX),
    fw.controlPoints.getObjectValue('absent', { a: 1 }, CTX),
  ] as const) {
    assert.equal((r as unknown) instanceof Promise, false);
  }
});

// ── fail-open, not fail-silent ──────────────────────────────────────────────

test('a prefetch timeout leaves the runtime STALE and serves STALE decisions', async () => {
  const hangs: WebBackendAdapter = {
    name: 'other',
    async initialize() {},
    prefetch: () => new Promise(() => {}), // never resolves
    async shutdown() {},
    features: () => ({ remoteEvaluation: true }),
  };
  const runtime = new FireweaveWebRuntime(hangs, {
    globalContext: CTX,
    flagsReadyTimeoutMs: 20,
  });
  await runtime.initialize();

  // Boot completed (fail-open) but the state says the truth (not fail-silent).
  assert.equal(runtime.getState(), 'STALE');

  const d = runtime.evaluateSync('anything', 'boolean', false, CTX);
  assert.equal(d.value, false);
  assert.equal(d.reason, 'STALE');
  // Crucially NOT FlagNotFound: the control point may well exist — we simply
  // never got an answer, and sending someone hunting for a missing flag would
  // be a lie.
  assert.equal(d.errorCode, undefined);
});

test('a timed-out boot is distinguishable from an all-off rollout', async () => {
  const allOff = new InMemoryWebAdapter({
    flags: { 'new-checkout': { type: 'boolean', enabled: true, value: false } },
  });
  const healthy = await readyRuntime(allOff);
  const offDecision = healthy.evaluateSync('new-checkout', 'boolean', false, CTX);

  assert.equal(healthy.getState(), 'READY');
  assert.notEqual(offDecision.reason, 'STALE');
  // Same value, different reason — which is the entire point.
  assert.equal(offDecision.value, false);
});

test('an adapter that fails to initialize reports ERROR, not READY', async () => {
  const runtime = new FireweaveWebRuntime(
    new InMemoryWebAdapter({ fault: { kind: 'Authentication', onInitialize: true } }),
    { globalContext: CTX }
  );
  await runtime.initialize();
  assert.equal(runtime.getState(), 'ERROR');

  const d = runtime.evaluateSync('x', 'boolean', false, CTX);
  assert.equal(d.reason, 'ERROR');
  assert.equal(d.value, false);
});

// ── evaluation semantics ────────────────────────────────────────────────────

test('a genuinely unknown control point reports FLAG_NOT_FOUND when READY', async () => {
  const runtime = await readyRuntime();
  const d = runtime.evaluateSync('never-configured', 'boolean', false, CTX);
  assert.equal(d.reason, 'ERROR');
  assert.equal(d.errorCode, 'FLAG_NOT_FOUND');
  assert.equal(d.value, false);
});

test('a type mismatch surfaces rather than silently defaulting', async () => {
  const runtime = await readyRuntime();
  const d = runtime.evaluateSync('new-checkout', 'string', 'fallback', CTX);
  assert.equal(d.errorCode, 'TYPE_MISMATCH');
  assert.equal(d.value, 'fallback');
});

test('evaluation never throws, even after shutdown', async () => {
  const runtime = await readyRuntime();
  await runtime.shutdown();
  const d = runtime.evaluateSync('new-checkout', 'boolean', false, CTX);
  assert.equal(d.reason, 'ERROR');
  assert.equal(d.errorKind, 'AlreadyClosed');
});

test('setContext re-prefetches and reports which control points moved', async () => {
  const adapter = new InMemoryWebAdapter({
    flags: {
      gated: { type: 'boolean', enabled: true, value: true, matchTargetingKey: 'user_42' },
    },
  });
  const runtime = await readyRuntime(adapter);
  assert.equal(runtime.evaluateSync('gated', 'boolean', false, CTX).value, true);

  const changed = await runtime.setContext({ targetingKey: 'someone_else' });
  assert.deepEqual([...changed], ['gated']);
  assert.equal(runtime.evaluateSync('gated', 'boolean', false).errorCode, 'FLAG_NOT_FOUND');
});

// ── the dev substrate ───────────────────────────────────────────────────────

test('the local adapter honours devFlags and misses default otherwise (spec/modes.md)', async () => {
  const runtime = await readyRuntime(new FireweaveLocalWebAdapter({ devFlags: { dogfood: true } }));

  const on = runtime.evaluateSync('dogfood', 'boolean', false, CTX);
  assert.equal(on.value, true);
  assert.equal(on.reason, 'STATIC');
  assert.equal(on.variant, 'on');

  // spec/modes.md "Behaviour per mode": local's unknown-key row is
  // `default`/reason `DEFAULT` — deliberately not an error, unlike remote's
  // `default`/`ERROR`/`FlagNotFound`. The local adapter signals this via its
  // `missReason: 'DEFAULT'` — a strict `===` seam the runtime checks.
  const miss = runtime.evaluateSync('other', 'boolean', false, CTX);
  assert.equal(miss.value, false);
  assert.equal(miss.reason, 'DEFAULT');
  assert.equal(miss.errorCode, undefined);
  assert.equal(miss.errorKind, undefined);
});

// ── security posture (ADR-0009) ─────────────────────────────────────────────

test('vendor and secret key shapes are rejected at construction', () => {
  for (const key of ['phc_abc123', 'phs_abc123', 'phx_abc123', '']) {
    assert.throws(
      () => assertNotSecretKey(key),
      (err: unknown) => err instanceof FireweaveError && err.kind === 'Configuration'
    );
  }
  assert.doesNotThrow(() => assertNotSecretKey('project-api-key_abc123'));
});

test('the remote adapter refuses a secret key before any request is made', () => {
  assert.throws(
    () =>
      new FireweaveRemoteWebAdapter({
        apiUrl: 'https://app-server.fireweave.ai',
        apiKey: 'phc_public_but_wrong',
      }),
    (err: unknown) => err instanceof FireweaveError && err.kind === 'Configuration'
  );
});

test('plain http off-loopback is refused; loopback is allowed for dev', async () => {
  const remote = new FireweaveRemoteWebAdapter({
    apiUrl: 'http://evil.example.com',
    apiKey: 'project-api-key_x',
  });
  await assert.rejects(() => remote.initialize());

  const local = new FireweaveRemoteWebAdapter({
    apiUrl: 'http://localhost:3901',
    apiKey: 'project-api-key_x',
  });
  await assert.doesNotReject(() => local.initialize());
});

test('the remote adapter reports remote-only evaluation, structurally', () => {
  const remote = new FireweaveRemoteWebAdapter({
    apiUrl: 'https://app-server.fireweave.ai',
    apiKey: 'project-api-key_x',
  });
  assert.equal(remote.features().localEvaluation, false);
  assert.equal(remote.features().remoteEvaluation, true);
});

// ── the client surface ──────────────────────────────────────────────────────

test('control points read synchronously off the client', async () => {
  const client = new FireweaveWebClient(await readyRuntime());
  assert.equal(client.controlPoints.getBooleanValue('new-checkout', false, CTX), true);
  assert.equal(client.controlPoints.getStringValue('copy', 'x', CTX), 'treatment');
  assert.equal(client.controlPoints.getBooleanValue('absent', false, CTX), false);
});

test('an unknown capability degrades, never throws', async () => {
  const client = new FireweaveWebClient(await readyRuntime());
  const result = client.invokeCapability('nonexistent.capability');
  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, 'UnsupportedCapability');
});

test('invokeCapability degrades cut-namespace capability names, not { ok: true } (v1 scope)', async () => {
  // v1 scope is exactly control points + target registration
  // (spec/control-points.md): releases, exposures, signals, capabilities
  // discovery and guardrails MUST NOT be exposed, including through the
  // dynamic dispatcher — a cut capability name resolves exactly like any
  // other unknown string, never a fabricated success.
  const client = new FireweaveWebClient(await readyRuntime());
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
    'guardrails.evaluate',
  ]) {
    const result = client.invokeCapability(capability);
    assert.equal(result.ok, false, `${capability} must not resolve ok:true`);
    assert.equal(result.error?.kind, 'UnsupportedCapability', `${capability} must degrade UnsupportedCapability`);
    assert.equal(result.degraded, true, `${capability} must be marked degraded`);
  }
});
