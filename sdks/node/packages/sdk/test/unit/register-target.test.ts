import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FireweaveRemoteAdapter,
  FireweaveRuntime,
  InMemoryAdapter,
} from '@fireweaveai/sdk';

type FetchCall = {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string };
};

function mockFetch(
  handler: (url: string, init?: FetchCall['init']) => { status: number; body: unknown },
  calls: FetchCall[] = [],
) {
  return async (url: string, init?: FetchCall['init']) => {
    calls.push(init === undefined ? { url } : { url, init });
    const result = handler(url, init);
    const text = JSON.stringify(result.body);
    return {
      status: result.status,
      text: async () => text,
      json: async () => result.body,
    };
  };
}

async function readyAdapter(
  fetch: ReturnType<typeof mockFetch>,
): Promise<FireweaveRemoteAdapter> {
  const adapter = new FireweaveRemoteAdapter({
    apiUrl: 'http://127.0.0.1:3901',
    apiKey: 'project-api-key_test',
    fetch,
  });
  await adapter.initialize();
  return adapter;
}

describe('FireweaveRemoteAdapter.registerTarget', () => {
  it('posts the target to /v1/targets/register with Bearer auth', async () => {
    const calls: FetchCall[] = [];
    const adapter = await readyAdapter(
      mockFetch(
        (url) => {
          assert.ok(url.endsWith('/v1/targets/register'));
          return { status: 200, body: { ok: true, targetingKey: 'user-1' } };
        },
        calls,
      ),
    );

    const result = await adapter.registerTarget('user-1', {
      kind: 'user',
      environment: 'production',
      properties: { plan: 'enterprise', beta: true },
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.init?.headers?.['authorization'], 'Bearer project-api-key_test');
    const body = JSON.parse(calls[0]?.init?.body ?? '{}') as Record<string, unknown>;
    assert.equal(body['targetingKey'], 'user-1');
    assert.equal(body['kind'], 'user');
    assert.equal(body['environment'], 'production');
    assert.deepEqual(body['properties'], { plan: 'enterprise', beta: true });
  });

  it('omits optional fields rather than sending undefined', async () => {
    const calls: FetchCall[] = [];
    const adapter = await readyAdapter(
      mockFetch(() => ({ status: 200, body: { ok: true } }), calls),
    );

    await adapter.registerTarget('device-9');

    const body = JSON.parse(calls[0]?.init?.body ?? '{}') as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ['targetingKey']);
  });

  it('never throws on transport failure — sign-in must not break', async () => {
    const adapter = await readyAdapter(
      mockFetch(() => ({ status: 500, body: {} })),
    );

    const result = await adapter.registerTarget('user-1');

    assert.equal(result.ok, false);
    assert.equal(result.error?.kind, 'BackendUnavailable');
  });

  it('retries a retryable failure exactly once', async () => {
    const calls: FetchCall[] = [];
    let attempts = 0;
    const adapter = await readyAdapter(
      mockFetch(
        () => {
          attempts += 1;
          return attempts === 1
            ? { status: 503, body: {} }
            : { status: 200, body: { ok: true } };
        },
        calls,
      ),
    );

    const result = await adapter.registerTarget('user-1');

    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
  });

  it('does not retry a rejected payload or bad key', async () => {
    const calls: FetchCall[] = [];
    const adapter = await readyAdapter(
      mockFetch(() => ({ status: 401, body: {} }), calls),
    );

    const result = await adapter.registerTarget('user-1');

    assert.equal(result.ok, false);
    assert.equal(result.error?.kind, 'Authentication');
    assert.equal(calls.length, 1, 'a rejected key is rejected identically on retry');
  });

  it('reports NotReady before initialize instead of silently succeeding', async () => {
    const adapter = new FireweaveRemoteAdapter({
      apiUrl: 'http://127.0.0.1:3901',
      apiKey: 'project-api-key_test',
      fetch: mockFetch(() => ({ status: 200, body: { ok: true } })),
    });

    const result = await adapter.registerTarget('user-1');

    assert.equal(result.ok, false);
    assert.equal(result.error?.kind, 'NotReady');
  });

  it('rejects an empty targeting key', async () => {
    const adapter = await readyAdapter(
      mockFetch(() => ({ status: 200, body: { ok: true } })),
    );

    const result = await adapter.registerTarget('');

    assert.equal(result.ok, false);
    assert.equal(result.error?.kind, 'InvalidContext');
  });
});

describe('FireweaveRuntime.registerTarget', () => {
  it('delegates to the adapter', async () => {
    const calls: FetchCall[] = [];
    const adapter = new FireweaveRemoteAdapter({
      apiUrl: 'http://127.0.0.1:3901',
      apiKey: 'project-api-key_test',
      fetch: mockFetch(() => ({ status: 200, body: { ok: true } }), calls),
    });
    const runtime = new FireweaveRuntime(adapter);
    await runtime.initialize();

    const result = await runtime.registerTarget('user-1', {
      properties: { plan: 'pro' },
    });

    assert.equal(result.ok, true);
    assert.ok(calls[0]?.url.endsWith('/v1/targets/register'));
  });

  it('reports UnsupportedCapability on an adapter without registration', async () => {
    const runtime = new FireweaveRuntime(new InMemoryAdapter({ flags: {} }));
    await runtime.initialize();

    const result = await runtime.registerTarget('user-1');

    assert.equal(result.ok, false);
    assert.equal(
      result.error?.kind,
      'UnsupportedCapability',
      'a dev harness must not look registered when it cannot register',
    );
  });
});
