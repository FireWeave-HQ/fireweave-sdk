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

function localSnapshot(flagKey = 'fw-x', overrides: Record<string, unknown> = {}) {
  let getFlagCalls = 0;
  const record = {
    key: flagKey,
    enabled: true,
    id: 7,
    version: 3,
    reason: 'condition_match',
    locallyEvaluated: true,
    ...overrides,
  };
  return {
    getFlagCalls: () => getFlagCalls,
    snapshot: {
      isEnabled: () => true,
      getFlag: () => {
        getFlagCalls += 1;
        return true as const;
      },
      getFlagPayload: () => undefined,
      keys: [flagKey],
      _flags: { [flagKey]: record },
    },
  };
}

test('injected client lifecycle stays with the caller (no shutdown call)', async () => {
  let shutdownCalled = false;
  const { snapshot } = localSnapshot();
  const fakeClient = {
    evaluateFlags: async () => snapshot,
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

test('RB-1: hybrid local serve without /flags observation is a Decision, not Network', async () => {
  const { snapshot, getFlagCalls } = localSnapshot();
  const fakeClient = {
    evaluateFlags: async () => snapshot,
    capture: () => {},
    flush: async () => {},
    shutdown: async () => {},
    isLocalEvaluationReady: () => true,
  };
  // Hybrid: secret key present, onlyEvaluateLocally NOT set — no HTTP observation.
  const adapter = new PostHogAdapter({ client: fakeClient, secretApiKey: 'phs_unit_test' });
  await adapter.initialize();
  const res = await adapter.resolve('fw-x', CTX);
  assert.equal(res.found, true);
  assert.equal(res.value, true);
  assert.equal(res.version, 3);
  assert.equal(getFlagCalls(), 0, 'must not call emitting getFlag on local/hybrid path');
});

test('RB-2: local snapshot path does not emit vendor $feature_flag_called', async () => {
  const captured: Array<{ distinctId: string; event: string; properties?: Record<string, unknown> }> = [];
  const { snapshot, getFlagCalls } = localSnapshot();
  const fakeClient = {
    evaluateFlags: async () => snapshot,
    capture: (props: { distinctId: string; event: string; properties?: Record<string, unknown> }) => {
      captured.push(props);
    },
    flush: async () => {},
    shutdown: async () => {},
    isLocalEvaluationReady: () => true,
  };
  const adapter = new PostHogAdapter({
    client: fakeClient,
    onlyEvaluateLocally: true,
    secretApiKey: 'phs_unit_test',
  });
  await adapter.initialize();
  const res = await adapter.resolve('fw-x', CTX);
  assert.equal(res.found, true);
  assert.equal(getFlagCalls(), 0);
  assert.equal(
    captured.filter((c) => c.event === '$feature_flag_called').length,
    0,
    'local-path evaluation must not emit vendor $feature_flag_called',
  );
});

test('exposure capture emits $feature_flag_called via the client', async () => {
  const captured: Array<{ distinctId: string; event: string; properties?: Record<string, unknown> }> = [];
  const { snapshot } = localSnapshot();
  const fakeClient = {
    evaluateFlags: async () => snapshot,
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
  assert.equal(captured[0]?.properties?.['fireweave.exposure'], true);
  assert.equal(captured[0]?.properties?.['fireweave.rolloutId'], 'rollout_01HZX0000000000000000001');
});

test('adapter enforces the default host allowlist at initialize (H-1)', async () => {
  const denied = new PostHogAdapter({
    projectApiKey: 'phc_unit_test_key',
    host: 'https://169.254.169.254',
  });
  await rejectsWithKind(denied.initialize(), 'Configuration');

  // https required off-loopback even for a custom-allowlisted host spelling:
  const insecure = new PostHogAdapter({
    projectApiKey: 'phc_unit_test_key',
    host: 'http://posthog.internal.example',
    allowedHosts: ['posthog.internal.example'],
  });
  await rejectsWithKind(insecure.initialize(), 'Configuration');
});

test('shutdown passes the configured deadline to the vendor client (no hardcoded 2s)', async () => {
  const timeouts: Array<number | undefined> = [];
  const { snapshot } = localSnapshot();
  const fakeClient = {
    evaluateFlags: async () => snapshot,
    capture: () => {},
    flush: async () => {},
    shutdown: async (ms?: number) => {
      timeouts.push(ms);
    },
  };
  // The injected-client path never shuts the client down, so drive the owned
  // path by intercepting the module-level behavior via a wrapper adapter.
  class OwnedClientAdapter extends PostHogAdapter {}
  const adapter = new OwnedClientAdapter({
    projectApiKey: 'phc_unit_test_key',
    host: 'http://localhost:9',
    shutdownTimeoutMs: 1234,
    fetch: makeFetch({ kind: 'respond', response: { status: 200, body: flagsBody() } }) as never,
  });
  await adapter.initialize();
  // Swap in the observable client before shutdown (ownsClient stays true).
  (adapter as unknown as { client: typeof fakeClient }).client = fakeClient;
  await adapter.shutdown();
  assert.deepEqual(timeouts, [1234]);
});

test('fireweave.* carve-out keys and aliases never leak into person_properties', async (t) => {
  const calls: FetchCall[] = [];
  const adapter = await adapterWithBehavior(
    { kind: 'respond', response: { status: 200, body: flagsBody() } },
    calls,
  );
  t.after(() => adapter.shutdown());
  const ctx: CanonicalContext = {
    targetingKey: 'user-42',
    attributes: {
      plan: 'pro',
      'fireweave.groups': { organization: 'org_1' },
      'fireweave.groupProperties': { organization: { tier: 'enterprise' } },
    },
    groups: { organization: 'org_1' },
    groupProperties: { organization: { tier: 'enterprise' } },
  };
  const res = await adapter.resolve('fw-x', ctx);
  assert.equal(res.found, true);
  const flagsCall = calls.find((c) => c.url.includes('/flags') && !c.url.includes('definitions'));
  const body = JSON.parse(flagsCall?.body ?? '{}') as {
    person_properties: Record<string, string>;
    groups?: Record<string, string>;
    group_properties?: Record<string, Record<string, string>>;
  };
  assert.deepEqual(Object.keys(body.person_properties).filter((k) => !k.startsWith('$')), ['plan']);
  assert.deepEqual(body.groups, { organization: 'org_1' });
  // posthog-node adds a $group_key directive; our property must ride along.
  assert.equal(body.group_properties?.organization?.tier, 'enterprise');
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
