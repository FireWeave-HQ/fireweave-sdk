/**
 * The build stamp the start profile uses to pick its default endpoint
 * (src/start/build-info.ts, written by tools/release/version.sh apply server)
 * must match package.json, and the published subpaths must exist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SDK_CHANNEL, SDK_VERSION } from '../../src/start/build-info.ts';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  version: string;
  exports: Record<string, Record<string, string>>;
};

test('SDK_VERSION is the package.json version', () => {
  assert.equal(SDK_VERSION, manifest.version, 'run tools/release/version.sh apply server <version> to restamp');
});

test('SDK_CHANNEL follows the version: -rc.N is staging, anything else production', () => {
  assert.equal(SDK_CHANNEL, /-rc\./.test(manifest.version) ? 'staging' : 'production');
});

test('./start and ./register resolve to built files, with a browser stub for each', () => {
  for (const subpath of ['./start', './register']) {
    const entry = manifest.exports[subpath];
    assert.ok(entry !== undefined, `exports['${subpath}'] missing`);
    for (const condition of ['types', 'browser', 'default'] as const) {
      const target = entry[condition];
      assert.ok(target !== undefined, `exports['${subpath}'].${condition} missing`);
      assert.ok(existsSync(join(packageRoot, target)), `${subpath} ${condition} → ${target} not built`);
    }
  }
});
