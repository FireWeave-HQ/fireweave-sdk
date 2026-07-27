import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FireweaveRuntime, FireweaveError } from '@fireweaveai/sdk';
import { PostHogAdapter } from '@fireweaveai/sdk/posthog';
import type { CanonicalContext } from '@fireweaveai/sdk';

/**
 * These tests use a REAL posthog-node client with a stubbed fetch — no live
 * network. The stub emulates the /flags?v=2 protocol per test-server/PLAN.md.
 */

type StubResponse = { status: number; body: string };
type StubBehavior =
  | { kind: 'respond'; response: StubResponse }
  | { kind: 'network-error' }
  | { kind: 'abort-error' };

interface FetchCall {
  url: string;
  body?: string;
}

function makeFetch(behavior: StubBehavior, calls: FetchCall[] = []) {
  return async (url: string, init?: { body?: string | Uint8Array; signal?: AbortSignal }) => {
    calls.push({ url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    if (url.includes('/flags') && !url.includes('/flags/definitions')) {
      if (behavior.kind === 'network-error') {
        throw Object.assign(new Error('ECONNREFUSED'), { name: 'FetchError' });
      }
      if (behavior.kind === 'abort-error') {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      return {
        status: behavior.response.status,
        text: async () => behavior.response.body,
        json: async () => JSON.parse(behavior.response.body) as unknown,
        headers: { get: () => null },
      };
    }
    // batch / other endpoints: succeed quietly
    return {
      status: 200,
      text: async () => '{"status":"ok"}',
      json: async () => ({ status: 'ok' }),
      headers: { get: () => null },
    };
  };
}

const CTX: CanonicalContext = { targetingKey: 'user-42', attributes: { plan: 'pro' } };

function flagsBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    flags: {
      'fw-x': {
        key: 'fw-x',
        enabled: true,
        variant: null,
        reason: { code: 'condition_match', condition_index: 0, description: 'matched' },
        metadata: { id: 7, version: 3, payload: null },
      },
    },
    errorsWhileComputingFlags: false,
    requestId: 'req-1',
    quotaLimited: null,
    ...overrides,
  });
}

async function adapterWithBehavior(behavior: StubBehavior, calls: FetchCall[] = []): Promise<PostHogAdapter> {
  const adapter = new PostHogAdapter({
    projectApiKey: 'phc_unit_test_key',
    host: 'http://localhost:9',
    fetch: makeFetch(behavior, calls) as never,
  });
  await adapter.initialize();
  return adapter;
}

async function rejectsWithKind(promise: Promise<unknown>, kind: string): Promise<void> {
  await assert.rejects(
    () => promise,
    (err: unknown) => err instanceof FireweaveError && err.kind === kind,
  );
}

test('successful /flags response maps to a found resolution with metadata', async (t) => {
  const calls: FetchCall[] = [];
  const adapter = await adapterWithBehavior(
    { kind: 'respond', response: { status: 200, body: flagsBody() } },
    calls,
  );
  t.after(() => adapter.shutdown());
  const res = await adapter.resolve('fw-x', CTX);
  assert.equal(res.found, true);
  assert.equal(res.value, true);
  assert.equal(res.version, 3);
  assert.equal(res.vendorFlagId, 7);
  assert.equal(res.reasonCode, 'condition_match');
  // request went to /flags with our distinct_id and person properties
  const flagsCall = calls.find((c) => c.url.includes('/flags') && !c.url.includes('definitions'));
  assert.ok(flagsCall !== undefined);
  const body = JSON.parse(flagsCall.body ?? '{}') as { distinct_id: string; person_properties: Record<string, string> };
  assert.equal(body.distinct_id, 'user-42');
  assert.equal(body.person_properties.plan, 'pro');
});

test('variant flags surface the variant as the value', async (t) => {
  const body = flagsBody({
    flags: {
      'fw-x': { key: 'fw-x', enabled: true, variant: 'treatment', reason: null, metadata: { version: 1 } },
    },
  });
  const adapter = await adapterWithBehavior({ kind: 'respond', response: { status: 200, body } });
  t.after(() => adapter.shutdown());
  const res = await adapter.resolve('fw-x', CTX);
  assert.equal(res.variant, 'treatment');
  assert.equal(res.value, 'treatment');
});

test('missing flag in response -> found:false (runtime maps to FlagNotFound)', async (t) => {
  const adapter = await adapterWithBehavior({
    kind: 'respond',
    response: { status: 200, body: flagsBody({ flags: {} }) },
  });
  t.after(() => adapter.shutdown());
  const res = await adapter.resolve('fw-x', CTX);
  assert.equal(res.found, false);
});

test('quotaLimited response -> found:false + quotaLimited metadata flag', async (t) => {
  const adapter = await adapterWithBehavior({
    kind: 'respond',
    response: { status: 200, body: flagsBody({ flags: {}, quotaLimited: ['feature_flags'] }) },
  });
  t.after(() => adapter.shutdown());
  const res = await adapter.resolve('fw-x', CTX);
  assert.equal(res.found, false);
  assert.equal(res.quotaLimited, true);
});

test('HTTP 401 -> Authentication', async (t) => {
  const adapter = await adapterWithBehavior({ kind: 'respond', response: { status: 401, body: '{}' } });
  t.after(() => adapter.shutdown());
  await rejectsWithKind(adapter.resolve('fw-x', CTX), 'Authentication');
});

test('HTTP 429 -> RateLimited', async (t) => {
  const adapter = await adapterWithBehavior({ kind: 'respond', response: { status: 429, body: '{}' } });
  t.after(() => adapter.shutdown());
  await rejectsWithKind(adapter.resolve('fw-x', CTX), 'RateLimited');
});

test('HTTP 500 -> BackendUnavailable', async (t) => {
  const adapter = await adapterWithBehavior({ kind: 'respond', response: { status: 500, body: 'oops' } });
  t.after(() => adapter.shutdown());
  await rejectsWithKind(adapter.resolve('fw-x', CTX), 'BackendUnavailable');
});

test('invalid JSON body -> MalformedResponse', async (t) => {
  const adapter = await adapterWithBehavior({
    kind: 'respond',
    response: { status: 200, body: '{"flags": {' },
  });
  t.after(() => adapter.shutdown());
  await rejectsWithKind(adapter.resolve('fw-x', CTX), 'MalformedResponse');
});

test('network failure -> Network', async (t) => {
  const adapter = await adapterWithBehavior({ kind: 'network-error' });
  t.after(() => adapter.shutdown());
  await rejectsWithKind(adapter.resolve('fw-x', CTX), 'Network');
});

test('abort -> Timeout', async (t) => {
  const adapter = await adapterWithBehavior({ kind: 'abort-error' });
  t.after(() => adapter.shutdown());
  await rejectsWithKind(adapter.resolve('fw-x', CTX), 'Timeout');
});

test('missing targetingKey -> InvalidContext / TARGETING_KEY_MISSING', async (t) => {
  const adapter = await adapterWithBehavior({ kind: 'respond', response: { status: 200, body: flagsBody() } });
  t.after(() => adapter.shutdown());
  await assert.rejects(
    () => adapter.resolve('fw-x', { attributes: {} }),
    (err: unknown) =>
      err instanceof FireweaveError &&
      err.kind === 'InvalidContext' &&
      err.openFeatureErrorCode === 'TARGETING_KEY_MISSING',
  );
});

test('missing projectApiKey -> Configuration at initialize', async () => {
  const adapter = new PostHogAdapter({ host: 'http://localhost:9' });
  await rejectsWithKind(adapter.initialize(), 'Configuration');
});

test('resolve after shutdown -> AlreadyClosed', async () => {
  const adapter = await adapterWithBehavior({ kind: 'respond', response: { status: 200, body: flagsBody() } });
  await adapter.shutdown();
  await rejectsWithKind(adapter.resolve('fw-x', CTX), 'AlreadyClosed');
});

test('injected client lifecycle stays with the caller (no shutdown call)', async () => {
  let shutdownCalled = false;
  const fakeClient = {
    evaluateFlags: async () => ({
      isEnabled: () => true,
      getFlag: () => true as const,
      getFlagPayload: () => undefined,
      keys: ['fw-x'],
    }),
    capture: () => {},
    flush: async () => {},
    shutdown: async () => {
      shutdownCalled = true;
    },
    isLocalEvaluationReady: () => true,
  };
  const adapter = new PostHogAdapter({ client: fakeClient, onlyEvaluateLocally: true });
  await adapter.initialize();
  const res = await adapter.resolve('fw-x', CTX);
  assert.equal(res.found, true);
  await adapter.shutdown();
  assert.equal(shutdownCalled, false, 'injected client must not be shut down by the adapter');
});

test('exposure capture emits $feature_flag_called via the client', async () => {
  const captured: Array<{ distinctId: string; event: string; properties?: Record<string, unknown> }> = [];
  const fakeClient = {
    evaluateFlags: async () => ({
      isEnabled: () => true,
      getFlag: () => true as const,
      getFlagPayload: () => undefined,
      keys: [],
    }),
    capture: (props: { distinctId: string; event: string; properties?: Record<string, unknown> }) => {
      captured.push(props);
    },
    flush: async () => {},
    shutdown: async () => {},
  };
  const adapter = new PostHogAdapter({ client: fakeClient, onlyEvaluateLocally: true });
  await adapter.initialize();
  adapter.recordExposure({
    targetingKey: 'u1',
    flagKey: 'fw-x',
    value: true,
    variant: 'on',
    rolloutId: 'rollout_01HZX0000000000000000001',
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.event, '$feature_flag_called');
  assert.equal(captured[0]?.distinctId, 'u1');
  assert.equal(captured[0]?.properties?.['$feature_flag'], 'fw-x');
  assert.equal(captured[0]?.properties?.['$feature_flag_response'], 'on');
  assert.equal(captured[0]?.properties?.['fireweave.rolloutId'], 'rollout_01HZX0000000000000000001');
});

test('end-to-end through runtime: quotaLimited becomes FlagNotFound + metadata', async (t) => {
  const adapter = await adapterWithBehavior({
    kind: 'respond',
    response: { status: 200, body: flagsBody({ flags: {}, quotaLimited: ['feature_flags'] }) },
  });
  t.after(() => adapter.shutdown());
  const runtime = new FireweaveRuntime(adapter, {
    projectApiKey: 'phc_unit_test_key',
    host: 'http://localhost:9',
  });
  await runtime.initialize();
  const decision = await runtime.evaluate('fw-x', 'boolean', false, { targetingKey: 'user-42' });
  assert.equal(decision.errorCode, 'FLAG_NOT_FOUND');
  assert.equal(decision.metadata['fireweave.quotaLimited'], true);
  assert.equal(decision.value, false);
});
