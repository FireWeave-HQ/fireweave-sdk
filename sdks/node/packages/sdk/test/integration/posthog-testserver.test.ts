import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { FireweaveError, FireweaveRuntime } from '@fireweaveai/sdk';
import { PostHogAdapter } from '@fireweaveai/sdk/posthog';
import type { CanonicalContext } from '@fireweaveai/sdk';

/**
 * Adapter integration tests: REAL posthog-node client speaking HTTP to the
 * deterministic loopback test-server stub (test-server/implementation).
 * No live PostHog network access.
 */

interface TestServer {
  url: string;
  port: number;
  state: { events: unknown[]; requestLog: Array<{ path: string }> };
  close(): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));
const serverModulePath = join(here, '..', '..', '..', '..', '..', '..', 'test-server', 'implementation', 'server.mjs');

const PROJECT_KEY = 'phc_test_integration';
let server: TestServer;

before(async () => {
  const mod = (await import(pathToFileURL(serverModulePath).href)) as {
    startTestServer(options?: { port?: number; projectApiKey?: string }): Promise<TestServer>;
  };
  server = await mod.startTestServer({ port: 0, projectApiKey: PROJECT_KEY });
});

after(async () => {
  await server.close();
});

beforeEach(async () => {
  await fetch(`${server.url}/_test/reset`, { method: 'POST' });
});

async function setFault(fault: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${server.url}/_test/fault`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fault),
  });
  assert.equal(res.status, 200);
}

function makeAdapter(extra: Record<string, unknown> = {}): PostHogAdapter {
  return new PostHogAdapter({
    projectApiKey: PROJECT_KEY,
    host: server.url,
    featureFlagsRequestTimeoutMs: 2000,
    ...extra,
  });
}

const CTX: CanonicalContext = { targetingKey: 'user_int_1', attributes: { plan: 'pro' } };

async function withAdapter<T>(
  fn: (adapter: PostHogAdapter) => Promise<T>,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const adapter = makeAdapter(extra);
  await adapter.initialize();
  try {
    return await fn(adapter);
  } finally {
    await adapter.shutdown();
  }
}

const kindOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'none';
  } catch (err) {
    return err instanceof FireweaveError ? err.kind : `unexpected:${String(err)}`;
  }
};

test('remote evaluation: boolean flag resolves over the wire with metadata', async () => {
  await withAdapter(async (adapter) => {
    const res = await adapter.resolve('fw-bool-on', CTX);
    assert.equal(res.found, true);
    assert.equal(res.value, true);
    assert.equal(res.version, 1);
    assert.equal(res.reasonCode, 'condition_match');
  });
});

test('remote evaluation: multivariate flag returns variant value', async () => {
  await withAdapter(async (adapter) => {
    const res = await adapter.resolve('fw-mv-checkout', CTX);
    assert.equal(res.found, true);
    assert.equal(res.variant, 'treatment-b');
    assert.equal(res.value, 'treatment-b');
    assert.equal(res.version, 7);
  });
});

test('remote evaluation: disabled flag resolves enabled:false', async () => {
  await withAdapter(async (adapter) => {
    const res = await adapter.resolve('fw-disabled', CTX);
    assert.equal(res.found, true);
    assert.equal(res.enabled, false);
    assert.equal(res.value, false);
  });
});

test('unknown flag -> found:false', async () => {
  await withAdapter(async (adapter) => {
    const res = await adapter.resolve('does-not-exist', CTX);
    assert.equal(res.found, false);
  });
});

test('fault 401 -> Authentication', async () => {
  await setFault({ mode: '401' });
  await withAdapter(async (adapter) => {
    assert.equal(await kindOf(adapter.resolve('fw-bool-on', CTX)), 'Authentication');
  });
});

test('fault 429 -> RateLimited', async () => {
  await setFault({ mode: '429' });
  await withAdapter(async (adapter) => {
    assert.equal(await kindOf(adapter.resolve('fw-bool-on', CTX)), 'RateLimited');
  });
});

test('fault 500 -> BackendUnavailable', async () => {
  await setFault({ mode: '500' });
  await withAdapter(async (adapter) => {
    assert.equal(await kindOf(adapter.resolve('fw-bool-on', CTX)), 'BackendUnavailable');
  });
});

test('fault invalid_json -> MalformedResponse', async () => {
  await setFault({ mode: 'invalid_json' });
  await withAdapter(async (adapter) => {
    assert.equal(await kindOf(adapter.resolve('fw-bool-on', CTX)), 'MalformedResponse');
  });
});

test('fault truncated -> Network', async () => {
  await setFault({ mode: 'truncated' });
  await withAdapter(async (adapter) => {
    assert.equal(await kindOf(adapter.resolve('fw-bool-on', CTX)), 'Network');
  });
});

test('fault quota_limited -> found:false with quotaLimited (FlagNotFound at runtime)', async () => {
  await setFault({ mode: 'quota_limited' });
  await withAdapter(async (adapter) => {
    const runtime = new FireweaveRuntime(adapter, { projectApiKey: PROJECT_KEY, host: server.url });
    await runtime.initialize();
    const decision = await runtime.evaluate('fw-bool-on', 'boolean', false, {
      targetingKey: 'user_int_1',
      plan: 'pro',
    });
    assert.equal(decision.errorCode, 'FLAG_NOT_FOUND');
    assert.equal(decision.metadata['fireweave.quotaLimited'], true);
  });
});

test('fault delay + short timeout -> Timeout', async () => {
  await setFault({ mode: 'delay', delayMs: 3000, ttlRequests: 1 });
  await withAdapter(
    async (adapter) => {
      assert.equal(await kindOf(adapter.resolve('fw-bool-on', CTX)), 'Timeout');
    },
    { featureFlagsRequestTimeoutMs: 150 },
  );
});

test('offline backend (closed port) -> Network', async () => {
  const adapter = new PostHogAdapter({
    projectApiKey: PROJECT_KEY,
    host: 'http://127.0.0.1:1',
    featureFlagsRequestTimeoutMs: 500,
  });
  await adapter.initialize();
  try {
    assert.equal(await kindOf(adapter.resolve('fw-bool-on', CTX)), 'Network');
  } finally {
    await adapter.shutdown();
  }
});

test('fault ttlRequests recovers: first request fails, second succeeds', async () => {
  await setFault({ mode: '500', ttlRequests: 1 });
  await withAdapter(async (adapter) => {
    assert.equal(await kindOf(adapter.resolve('fw-bool-on', CTX)), 'BackendUnavailable');
    const res = await adapter.resolve('fw-bool-on', CTX);
    assert.equal(res.found, true);
  });
});

test('exposures flow to /batch and are visible via the admin endpoint', async () => {
  await withAdapter(async (adapter) => {
    adapter.recordExposure({
      targetingKey: 'user_int_1',
      flagKey: 'fw-bool-on',
      value: true,
      variant: 'on',
    });
    await adapter.flush();
  });
  const res = await fetch(`${server.url}/_test/events`);
  const body = (await res.json()) as { events: Array<{ event: string; properties?: Record<string, unknown> }> };
  const exposureEvents = body.events.filter((e) => e.event === '$feature_flag_called');
  assert.equal(exposureEvents.length, 1);
  assert.equal(exposureEvents[0]?.properties?.['$feature_flag'], 'fw-bool-on');
});

test('wrong project key -> Authentication', async () => {
  const adapter = new PostHogAdapter({
    projectApiKey: 'phc_wrong_key',
    host: server.url,
    featureFlagsRequestTimeoutMs: 1000,
  });
  await adapter.initialize();
  try {
    assert.equal(await kindOf(adapter.resolve('fw-bool-on', CTX)), 'Authentication');
  } finally {
    await adapter.shutdown();
  }
});
