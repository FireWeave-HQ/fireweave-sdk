/**
 * initFireweave — the single entry point (spec/modes.md).
 *
 * Covers every row of the initialisation-validation table, both modes'
 * adapter selection, and the "does nothing else conditional on mode"
 * property: once a client exists, its read / registerTarget behaviour is
 * identical across modes — only the underlying adapter differs. The
 * registerTarget wiring itself (recording + `[fireweave:local]` trace) is
 * NOT re-implemented here — it is commit 43bb492's
 * `FireweaveLocalAdapter.registerTarget`; these tests only assert it is
 * reachable through the new entry point.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FireweaveClient,
  FireweaveError,
  FireweaveLocalAdapter,
  FireweaveRemoteAdapter,
  initFireweave,
} from '@fireweaveai/sdk';
import type { InitFireweaveOptions } from '@fireweaveai/sdk';

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

async function rejectsConfiguration(options: unknown): Promise<void> {
  await assert.rejects(
    () => initFireweave(options as InitFireweaveOptions),
    (err: unknown) => {
      assert.ok(err instanceof FireweaveError);
      assert.equal(err.kind, 'Configuration');
      return true;
    },
  );
}

describe('initFireweave — initialisation validation table (spec/modes.md)', () => {
  it('mode absent is Configuration', async () => {
    await rejectsConfiguration({});
  });

  it('mode missing entirely (no options object) is Configuration, not a crash', async () => {
    await rejectsConfiguration(undefined);
    await rejectsConfiguration(null);
  });

  it('mode unrecognised is Configuration', async () => {
    await rejectsConfiguration({ mode: 'staging' });
    await rejectsConfiguration({ mode: 'LOCAL' });
  });

  it('remote mode with apiKey missing is Configuration', async () => {
    await rejectsConfiguration({ mode: 'remote', apiUrl: 'https://app-server.fireweave.ai' });
  });

  it('remote mode with apiUrl missing is Configuration', async () => {
    await rejectsConfiguration({ mode: 'remote', apiKey: 'project-api-key_test' });
  });

  it('remote mode with blank apiKey or apiUrl is Configuration', async () => {
    await rejectsConfiguration({
      mode: 'remote',
      apiKey: '   ',
      apiUrl: 'https://app-server.fireweave.ai',
    });
    await rejectsConfiguration({
      mode: 'remote',
      apiKey: 'project-api-key_test',
      apiUrl: '   ',
    });
  });

  it('apiUrl failing the host allowlist is Configuration', async () => {
    await rejectsConfiguration({
      mode: 'remote',
      apiKey: 'project-api-key_test',
      apiUrl: 'https://evil.example.com',
    });
  });

  it('local mode with credentials supplied is Configuration — the caller means one or the other', async () => {
    await rejectsConfiguration({ mode: 'local', apiKey: 'project-api-key_test' });
    await rejectsConfiguration({ mode: 'local', apiUrl: 'https://app-server.fireweave.ai' });
    await rejectsConfiguration({
      mode: 'local',
      apiKey: 'project-api-key_test',
      apiUrl: 'https://app-server.fireweave.ai',
      local: { controlPoints: {} },
    });
  });

  it('local mode with blank apiKey/apiUrl is not treated as "supplied" (symmetric with the remote row)', async () => {
    const client = await initFireweave(
      { mode: 'local', apiKey: '', apiUrl: '   ', local: { controlPoints: {} } } as unknown as InitFireweaveOptions,
    );
    assert.ok(client instanceof FireweaveClient);
    await client.shutdown();
  });
});

describe('initFireweave — adapter selection', () => {
  it('local mode selects FireweaveLocalAdapter, seeds the map, and reaches READY', async () => {
    const client = await initFireweave({
      mode: 'local',
      local: { controlPoints: { 'checkout-v2': true } },
    });

    assert.ok(client instanceof FireweaveClient);
    assert.ok(client.runtime.adapter instanceof FireweaveLocalAdapter);
    assert.equal(client.runtime.getState(), 'READY');

    const on = await client.controlPoints.getBooleanValue('checkout-v2', false);
    assert.equal(on, true);
    const details = await client.controlPoints.getBooleanDetails('checkout-v2', false);
    assert.equal(details.reason, 'STATIC');

    await client.shutdown();
  });

  it('local mode allows an empty or omitted controlPoints map (spec: "may be empty")', async () => {
    const empty = await initFireweave({ mode: 'local', local: { controlPoints: {} } });
    assert.equal(empty.runtime.getState(), 'READY');
    await empty.shutdown();

    const omitted = await initFireweave({ mode: 'local' });
    assert.equal(omitted.runtime.getState(), 'READY');
    await omitted.shutdown();
  });

  it('remote mode selects FireweaveRemoteAdapter and evaluates over POST /v1/flags/evaluate', async () => {
    const calls: FetchCall[] = [];
    const client = await initFireweave({
      mode: 'remote',
      apiKey: 'project-api-key_test',
      apiUrl: 'http://127.0.0.1:3901',
      fetch: mockFetch((url) => {
        assert.ok(url.endsWith('/v1/flags/evaluate'));
        return {
          status: 200,
          body: {
            decisions: [
              { flagKey: 'checkout-v2', value: true, reason: 'TARGETING_MATCH', found: true, enabled: true },
            ],
          },
        };
      }, calls),
    });

    assert.ok(client instanceof FireweaveClient);
    assert.ok(client.runtime.adapter instanceof FireweaveRemoteAdapter);
    assert.equal(client.runtime.getState(), 'READY');

    const on = await client.controlPoints.getBooleanValue('checkout-v2', false, { targetingKey: 'user-1' });
    assert.equal(on, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.init?.headers?.['authorization'], 'Bearer project-api-key_test');

    await client.shutdown();
  });

  it('remote mode: an explicit allowedHosts override permits a self-hosted apiUrl', async () => {
    const client = await initFireweave({
      mode: 'remote',
      apiKey: 'project-api-key_test',
      apiUrl: 'https://fw.internal.example',
      allowedHosts: ['fw.internal.example'],
    });
    assert.equal(client.runtime.getState(), 'READY');
    await client.shutdown();
  });
});

describe('initFireweave — does nothing else conditional on mode', () => {
  it('reads never throw in either mode: an unknown control point degrades to an ERROR decision', async () => {
    const local = await initFireweave({ mode: 'local', local: { controlPoints: {} } });
    const remote = await initFireweave({
      mode: 'remote',
      apiKey: 'project-api-key_test',
      apiUrl: 'http://127.0.0.1:3901',
      fetch: mockFetch(() => ({ status: 200, body: { decisions: [] } })),
    });

    for (const client of [local, remote]) {
      const decision = await client.controlPoints.getBooleanDetails('does-not-exist', false, {
        targetingKey: 'user-1',
      });
      assert.equal(decision.value, false);
      assert.equal(decision.reason, 'ERROR');
      assert.equal(decision.errorKind, 'FlagNotFound');
    }

    await local.shutdown();
    await remote.shutdown();
  });

  it('registerTarget resolves rather than raising in both modes (spec/modes.md)', async () => {
    const local = await initFireweave({ mode: 'local', local: { controlPoints: {} } });
    const remote = await initFireweave({
      mode: 'remote',
      apiKey: 'project-api-key_test',
      apiUrl: 'http://127.0.0.1:3901',
      fetch: mockFetch(() => ({ status: 200, body: { ok: true } })),
    });

    const localResult = await local.registerTarget('user-1');
    const remoteResult = await remote.registerTarget('user-1');
    assert.equal(localResult.ok, true);
    assert.equal(remoteResult.ok, true);

    await local.shutdown();
    await remote.shutdown();
  });
});

describe('initFireweave — local registerTarget wiring (commit 43bb492, not reimplemented here)', () => {
  it('records the target in-process and traces via the injected log sink', async () => {
    const lines: string[] = [];
    const client = await initFireweave({
      mode: 'local',
      local: { controlPoints: {}, log: (m) => lines.push(m) },
    });

    const result = await client.registerTarget('user-1', { properties: { plan: 'pro' } });
    assert.equal(result.ok, true);

    const adapter = client.runtime.adapter as FireweaveLocalAdapter;
    const [recorded] = adapter.getRegisteredTargets();
    assert.equal(recorded?.targetingKey, 'user-1');
    assert.deepEqual(recorded?.properties, { plan: 'pro' });

    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /\[fireweave:local\]/);
    assert.match(lines[0]!, /NOT sent to fw-server/);

    await client.shutdown();
  });
});
