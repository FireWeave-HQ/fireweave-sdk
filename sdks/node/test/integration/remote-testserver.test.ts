/**
 * Integration: FireweaveRemoteAdapter against the Fireweave-protocol stub
 * (test-server /v1/flags/evaluate + /v1/capture).
 */
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FireweaveRemoteAdapter, FireweaveRuntime, FireweaveClient } from '@fireweaveai/server-sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(
  __dirname,
  '../../../../test-server/implementation/server.mjs',
);

type Started = { url: string; close: () => Promise<void> };

describe('FireweaveRemoteAdapter ↔ test-server', () => {
  let server: Started;
  const apiKey = 'project-api-key_integration';

  before(async () => {
    const mod = (await import(serverPath)) as {
      startTestServer: (opts: {
        port: number;
        fireweaveApiKey?: string;
      }) => Promise<Started>;
    };
    server = await mod.startTestServer({ port: 0, fireweaveApiKey: apiKey });
  });

  after(async () => {
    await server.close();
  });

  it('evaluates fixture flags over the Fireweave wire protocol', async () => {
    const adapter = new FireweaveRemoteAdapter({
      apiUrl: server.url,
      apiKey,
      requestTimeoutMs: 3000,
    });
    const runtime = new FireweaveRuntime(adapter);
    await runtime.initialize();
    const client = new FireweaveClient(runtime);

    const on = await client.flags.getBooleanValue('fw-bool-on', false, {
      targetingKey: 'user-integration-1',
    });
    assert.equal(on, true);

    const theme = await client.flags.getStringValue('fw-string-theme', 'light', {
      targetingKey: 'user-integration-1',
    });
    assert.equal(theme, 'dark');

    await client.shutdown();
  });

  it('captures exposures via /v1/capture', async () => {
    const adapter = new FireweaveRemoteAdapter({
      apiUrl: server.url,
      apiKey,
    });
    await adapter.initialize();
    adapter.recordExposure({
      targetingKey: 'user-integration-2',
      flagKey: 'fw-bool-on',
      value: true,
    });
    await adapter.flush();

    const res = await fetch(`${server.url}/_test/events`);
    const body = (await res.json()) as { fwEvents: Array<{ type: string; flagKey: string }> };
    assert.ok(body.fwEvents.some((e) => e.type === 'exposure' && e.flagKey === 'fw-bool-on'));
    await adapter.shutdown();
  });

  it('rejects missing auth', async () => {
    const adapter = new FireweaveRemoteAdapter({
      apiUrl: server.url,
      apiKey: 'project-api-key_wrong',
    });
    await adapter.initialize();
    await assert.rejects(
      () => adapter.resolve('fw-bool-on', { targetingKey: 'u', attributes: {} }),
      (err: unknown) => (err as { kind?: string }).kind === 'Authentication',
    );
    await adapter.shutdown();
  });
});
