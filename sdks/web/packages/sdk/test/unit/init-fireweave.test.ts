/**
 * initFireweave — the single entry point (spec/modes.md).
 *
 * Covers every row of the initialisation-validation table and both modes'
 * adapter selection. `initFireweave` never branches on mode past adapter
 * selection — any behavioural difference between modes lives entirely in the
 * adapter seam (spec/modes.md "Behaviour per mode"), never in a mode check
 * downstream of it.
 *
 * Web-specific: `FireweaveWebRuntime.initialize()` never throws by design
 * (ADR-0009 "Fail-open, not fail-silent" — a hung prefetch must not block
 * boot), so mode.ts validates the four Configuration rows itself, before
 * ever calling into the runtime. These tests exist specifically to prove
 * that a bad host/credential still rejects `initFireweave`'s promise, even
 * though the runtime it wires up would swallow the same failure.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FireweaveError,
  FireweaveLocalWebAdapter,
  FireweaveRemoteWebAdapter,
  FireweaveWebClient,
  initFireweave,
} from '@fireweaveai/web-sdk';
import type { InitFireweaveOptions } from '@fireweaveai/web-sdk';

type FetchCall = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } };

function mockFetch(
  handler: (url: string, init?: FetchCall['init']) => { status: number; body: unknown },
  calls: FetchCall[] = []
) {
  return (async (url: string | URL | Request, rawInit?: RequestInit) => {
    const u = String(url);
    const init = rawInit as FetchCall['init'];
    if (init === undefined) {
      calls.push({ url: u });
    } else {
      calls.push({ url: u, init });
    }
    const result = handler(u, init);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

async function rejectsConfiguration(options: unknown): Promise<void> {
  await assert.rejects(
    () => initFireweave(options as InitFireweaveOptions),
    (err: unknown) => {
      assert.ok(err instanceof FireweaveError);
      assert.equal(err.kind, 'Configuration');
      return true;
    }
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
    const client = await initFireweave({
      mode: 'local',
      apiKey: '',
      apiUrl: '   ',
      local: { controlPoints: {} },
    } as unknown as InitFireweaveOptions);
    assert.ok(client instanceof FireweaveWebClient);
    await client.shutdown();
  });
});

describe('initFireweave — adapter selection', () => {
  it('local mode selects FireweaveLocalWebAdapter, seeds the map, and reaches READY', async () => {
    const client = await initFireweave({
      mode: 'local',
      local: { controlPoints: { 'checkout-v2': true } },
      context: { targetingKey: 'user-1' },
    });

    assert.ok(client instanceof FireweaveWebClient);
    assert.ok(client.runtime.adapter instanceof FireweaveLocalWebAdapter);
    assert.equal(client.runtime.getState(), 'READY');

    const on = client.controlPoints.getBooleanValue('checkout-v2', false);
    assert.equal(on, true);
    const details = client.controlPoints.getBooleanDetails('checkout-v2', false);
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

  it('remote mode selects FireweaveRemoteWebAdapter and evaluates over a batch POST /v1/flags/evaluate', async () => {
    const calls: FetchCall[] = [];
    const client = await initFireweave({
      mode: 'remote',
      apiKey: 'project-api-key_test',
      apiUrl: 'http://127.0.0.1:3901',
      context: { targetingKey: 'user-1' },
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

    assert.ok(client instanceof FireweaveWebClient);
    assert.ok(client.runtime.adapter instanceof FireweaveRemoteWebAdapter);
    assert.equal(client.runtime.getState(), 'READY');

    const on = client.controlPoints.getBooleanValue('checkout-v2', false);
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
      context: { targetingKey: 'user-1' },
      fetch: mockFetch(() => ({ status: 200, body: { decisions: [] } })),
    });
    assert.equal(client.runtime.getState(), 'READY');
    await client.shutdown();
  });
});

describe('initFireweave — does nothing else conditional on mode', () => {
  it('reads never throw in either mode', async () => {
    const local = await initFireweave({
      mode: 'local',
      local: { controlPoints: {} },
      context: { targetingKey: 'user-1' },
    });
    const remote = await initFireweave({
      mode: 'remote',
      apiKey: 'project-api-key_test',
      apiUrl: 'http://127.0.0.1:3901',
      context: { targetingKey: 'user-1' },
      fetch: mockFetch(() => ({ status: 200, body: { decisions: [] } })),
    });

    const localDecision = local.controlPoints.getBooleanDetails('does-not-exist', false);
    assert.equal(localDecision.value, false);

    const remoteDecision = remote.controlPoints.getBooleanDetails('does-not-exist', false);
    assert.equal(remoteDecision.value, false);
    assert.equal(remoteDecision.reason, 'ERROR');
    assert.equal(remoteDecision.errorKind, 'FlagNotFound');

    await local.shutdown();
    await remote.shutdown();
  });

  it('registerTarget resolves rather than raising in both modes (spec/modes.md)', async () => {
    // Local mode's registerTarget is wired to record-and-trace (rather than
    // report UnsupportedCapability) in a later commit in this sequence —
    // this test only pins the "resolves, never throws" half for now; the
    // dedicated local-register-target.test.ts pins the recording/tracing
    // behaviour once it lands.
    const local = await initFireweave({ mode: 'local', local: { controlPoints: {} } });
    const remote = await initFireweave({
      mode: 'remote',
      apiKey: 'project-api-key_test',
      apiUrl: 'http://127.0.0.1:3901',
      fetch: mockFetch(() => ({ status: 200, body: { ok: true } })),
    });

    await assert.doesNotReject(() => local.registerTarget('user-1'));
    const remoteResult = await remote.registerTarget('user-1');
    assert.equal(remoteResult.ok, true);

    await local.shutdown();
    await remote.shutdown();
  });
});
