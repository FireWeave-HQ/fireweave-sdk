/**
 * Regression: FireweaveRemoteAdapter.shutdown() used to leave its race timer
 * armed, so a process that shut down cleanly still waited up to
 * shutdownTimeoutMs (10 s by default) before it could exit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('a clean shutdown lets the process exit immediately', () => {
  const script = `
    import { FireweaveRemoteAdapter } from '@fireweaveai/server-sdk';
    const adapter = new FireweaveRemoteAdapter({ apiUrl: 'https://app-server.fireweave.ai', apiKey: 'project-api-key_x' });
    await adapter.initialize();
    await adapter.shutdown();
  `;
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: packageRoot, encoding: 'utf8', timeout: 15_000 });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 0, result.stderr);
  assert.ok(elapsed < 5_000, `process took ${elapsed} ms to exit after shutdown (timer left armed?)`);
});
