import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FireweaveRemoteAdapter, FireweaveError } from '@fireweaveai/sdk';

type FetchCall = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } };

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

describe('FireweaveRemoteAdapter', () => {
  it('requires apiUrl and apiKey on initialize', async () => {
    const adapter = new FireweaveRemoteAdapter({});
    await assert.rejects(() => adapter.initialize(), (err: unknown) => {
      assert.ok(err instanceof FireweaveError);
      assert.equal(err.kind, 'Configuration');
      return true;
    });
  });

  it('evaluates a flag via POST /v1/flags/evaluate with Bearer auth', async () => {
    const calls: FetchCall[] = [];
    const fetch = mockFetch((url) => {
      assert.ok(url.endsWith('/v1/flags/evaluate'));
      return {
        status: 200,
        body: {
          decisions: [
            {
              flagKey: 'checkout-v2',
              value: true,
              reason: 'TARGETING_MATCH',
              found: true,
              enabled: true,
              flagMetadata: { 'fireweave.backend': 'other' },
            },
          ],
          requestId: 'req-1',
        },
      };
    }, calls);

    const adapter = new FireweaveRemoteAdapter({
      apiUrl: 'http://127.0.0.1:3901',
      apiKey: 'project-api-key_test',
      fetch,
    });
    await adapter.initialize();
    const resolution = await adapter.resolve('checkout-v2', {
      targetingKey: 'user-1',
      attributes: { plan: 'pro' },
    });
    assert.equal(resolution.found, true);
    assert.equal(resolution.value, true);
    assert.equal(resolution.reason, 'TARGETING_MATCH');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.init?.headers?.['authorization'], 'Bearer project-api-key_test');
    const body = JSON.parse(calls[0]?.init?.body ?? '{}') as {
      targetingKey: string;
      flagKeys: string[];
      attributes: Record<string, string>;
    };
    assert.equal(body.targetingKey, 'user-1');
    assert.deepEqual(body.flagKeys, ['checkout-v2']);
    assert.equal(body.attributes.plan, 'pro');
    await adapter.shutdown();
  });

  it('maps 401 to Authentication', async () => {
    const adapter = new FireweaveRemoteAdapter({
      apiUrl: 'http://127.0.0.1:3901',
      apiKey: 'project-api-key_bad',
      fetch: mockFetch(() => ({ status: 401, body: { ok: false } })),
    });
    await adapter.initialize();
    await assert.rejects(
      () => adapter.resolve('x', { targetingKey: 'u', attributes: {} }),
      (err: unknown) => {
        assert.ok(err instanceof FireweaveError);
        assert.equal(err.kind, 'Authentication');
        return true;
      },
    );
    await adapter.shutdown();
  });

  it('buffers exposures and flushes to /v1/capture', async () => {
    const calls: FetchCall[] = [];
    const fetch = mockFetch((url) => {
      if (url.includes('/v1/capture')) {
        return { status: 200, body: { ok: true, accepted: 1 } };
      }
      return {
        status: 200,
        body: { decisions: [{ flagKey: 'f', value: true, reason: 'STATIC', found: true }] },
      };
    }, calls);

    const adapter = new FireweaveRemoteAdapter({
      apiUrl: 'http://127.0.0.1:3901',
      apiKey: 'project-api-key_test',
      fetch,
    });
    await adapter.initialize();
    adapter.recordExposure({
      targetingKey: 'user-1',
      flagKey: 'checkout-v2',
      value: true,
      variant: 'on',
    });
    await adapter.flush();
    const capture = calls.find((c) => c.url.includes('/v1/capture'));
    assert.ok(capture);
    const body = JSON.parse(capture?.init?.body ?? '{}') as {
      events: Array<{ type: string; flagKey: string }>;
    };
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0]?.type, 'exposure');
    assert.equal(body.events[0]?.flagKey, 'checkout-v2');
    await adapter.shutdown();
  });

  it('rejects non-loopback http apiUrl', async () => {
    const adapter = new FireweaveRemoteAdapter({
      apiUrl: 'http://example.com',
      apiKey: 'project-api-key_test',
      allowedHosts: ['*'],
    });
    await assert.rejects(() => adapter.initialize(), (err: unknown) => {
      assert.ok(err instanceof FireweaveError);
      assert.equal(err.kind, 'Configuration');
      return true;
    });
  });

  it('reports remote-only features', async () => {
    const adapter = new FireweaveRemoteAdapter({
      apiUrl: 'http://127.0.0.1:3901',
      apiKey: 'project-api-key_test',
      fetch: mockFetch(() => ({ status: 200, body: { decisions: [] } })),
    });
    await adapter.initialize();
    const features = adapter.features();
    assert.equal(features.remoteEvaluation, true);
    assert.equal(features.localEvaluation, false);
    assert.equal(features.sideEffectFreeReads, true);
    assert.equal(adapter.name, 'fireweave');
    await adapter.shutdown();
  });
});
