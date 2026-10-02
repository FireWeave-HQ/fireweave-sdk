/**
 * Integration: the start profile in remote mode against the Fireweave-protocol
 * stub (test-server), through the published `@fireweaveai/server-sdk/start` export.
 */
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, fw, resetForTests } from '@fireweaveai/server-sdk/start';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, '../../../../test-server/implementation/server.mjs');

type Started = { url: string; close: () => Promise<void> };

describe('start() in remote mode ↔ test-server', () => {
  let server: Started;
  const key = 'project-api-key_integration';

  before(async () => {
    const mod = (await import(serverPath)) as {
      startTestServer: (opts: { port: number; fireweaveApiKey?: string }) => Promise<Started>;
    };
    server = await mod.startTestServer({ port: 0, fireweaveApiKey: key });
  });

  after(async () => {
    await resetForTests();
    await server.close();
  });

  it('a key plus a custom endpoint evaluates over the wire; flags are ignored for values', async () => {
    start({ key, url: server.url, env: { NODE_ENV: 'production' }, flags: { 'fw-bool-on': { local: false } }, log: () => undefined });
    assert.equal(await fw.controlPoints.getBooleanValue('fw-bool-on', false, { targetingKey: 'user-1' }), true);
    assert.equal(await fw.controlPoints.getStringValue('fw-string-theme', 'light', { targetingKey: 'user-1' }), 'dark');
    const status = fw.status();
    assert.equal(status.mode, 'remote');
    assert.equal(status.endpointSource, 'start({ url })');
    assert.equal(status.host, new URL(server.url).hostname);
    await fw.shutdown();
  });

  it('a wrong key never throws from a read: the default is served with the reason', async () => {
    await resetForTests();
    start({ key: 'project-api-key_wrong', url: server.url, env: {}, log: () => undefined });
    const decision = await fw.controlPoints.getBooleanDetails('fw-bool-on', false, { targetingKey: 'user-1' });
    assert.equal(decision.value, false);
    assert.equal(decision.reason, 'ERROR');
    assert.equal(decision.errorKind, 'Authentication');
    await fw.shutdown();
  });
});
