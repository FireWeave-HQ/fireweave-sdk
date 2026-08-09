import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FireweaveError,
  FireweaveLocalWebAdapter,
  FireweaveRemoteWebAdapter,
  FireweaveWebClient,
  FireweaveWebProvider,
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

test('resolve*Evaluation returns ResolutionDetails, NOT a Promise', async () => {
  const provider = new FireweaveWebProvider(await readyRuntime());

  // This is the load-bearing web contract: call sites read control points
  // without `await`, inside render paths where awaiting is impossible.
  const details = provider.resolveBooleanEvaluation('new-checkout', false, CTX);
  assert.equal(details instanceof Promise, false);
  assert.equal(details.value, true);

  for (const r of [
    provider.resolveStringEvaluation('copy', 'x', CTX),
    provider.resolveNumberEvaluation('absent', 1, CTX),
    provider.resolveObjectEvaluation('absent', { a: 1 }, CTX),
  ]) {
    assert.equal(r instanceof Promise, false);
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

test('the local adapter honours devFlags and misses otherwise', async () => {
  const runtime = await readyRuntime(new FireweaveLocalWebAdapter({ devFlags: { dogfood: true } }));

  const on = runtime.evaluateSync('dogfood', 'boolean', false, CTX);
  assert.equal(on.value, true);
  assert.equal(on.reason, 'STATIC');
  assert.equal(on.variant, 'on');

  // An unconfigured key is a real miss here — the harness's DEV provider is
  // what converts that into a clean default, mirroring the server SDK.
  assert.equal(runtime.evaluateSync('other', 'boolean', false, CTX).errorCode, 'FLAG_NOT_FOUND');
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
  const client = new FireweaveWebClient(await readyRuntime(), { autoFlushOnUnload: false });
  assert.equal(client.controlPoints.getBooleanValue('new-checkout', false, CTX), true);
  assert.equal(client.controlPoints.getStringValue('copy', 'x', CTX), 'treatment');
  assert.equal(client.controlPoints.getBooleanValue('absent', false, CTX), false);
});

test('capabilities report the web binding honestly', async () => {
  const client = new FireweaveWebClient(await readyRuntime(), { autoFlushOnUnload: false });
  const caps = client.capabilities.get();

  assert.equal(caps.static.language, 'web');
  assert.equal(caps.static.openFeature.serverOnly, false);
  assert.equal(caps.static.features.controlPoints, true);
  // Absent, not false: this package never had a vendor adapter, so reporting
  // one as "off" would imply an integration that could be switched on.
  assert.equal('posthogAdapter' in caps.static.features, false);
  assert.equal(caps.runtime.features.localEvaluation, false);
});

test('exposures dedupe per (flagKey, targetingKey, variant)', async () => {
  const adapter = flagsAdapter();
  const client = new FireweaveWebClient(await readyRuntime(adapter), {
    autoFlushOnUnload: false,
  });
  const exposure = { flagKey: 'new-checkout', targetingKey: 'user_42', value: true, variant: 'on' };

  client.exposures.record(exposure);
  client.exposures.record(exposure);
  client.exposures.record({ ...exposure, targetingKey: 'user_99' });

  assert.equal(adapter.getExposures().length, 2);
});

test('release context stamps subsequent signals', async () => {
  const adapter = flagsAdapter();
  const client = new FireweaveWebClient(await readyRuntime(adapter), {
    autoFlushOnUnload: false,
  });
  client.releases.setContext({ rolloutId: 'ro_1', changeId: 'ch_1' });
  client.signals.recordHealth({ name: 'checkout.ok', status: 'healthy' });

  const [signal] = adapter.getSignals();
  assert.equal(signal?.rolloutId, 'ro_1');
  assert.equal(signal?.changeId, 'ch_1');
});

test('extensions degrade before initialize rather than throwing', () => {
  const runtime = new FireweaveWebRuntime(flagsAdapter());
  const client = new FireweaveWebClient(runtime, { autoFlushOnUnload: false });

  const result = client.signals.recordHealth({ name: 'too.early' });
  assert.equal(result.ok, false);
  assert.equal(result.degraded, true);
  assert.equal(result.error?.kind, 'NotReady');
});

test('an unknown capability degrades, never throws', async () => {
  const client = new FireweaveWebClient(await readyRuntime(), { autoFlushOnUnload: false });
  const result = client.invokeCapability('nonexistent.capability');
  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, 'UnsupportedCapability');
});

test('guardrails remain an honest stub', async () => {
  const client = new FireweaveWebClient(await readyRuntime(), { autoFlushOnUnload: false });
  assert.equal(client.guardrails.evaluate('anything').error?.kind, 'UnsupportedCapability');
});
