/**
 * The release stamp the start profile reads its default endpoint from.
 * tools/release/version.sh apply web rewrites src/start/build-info.ts; this pins
 * it to package.json so a release that forgets to stamp fails CI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SDK_CHANNEL, SDK_VERSION } from '@fireweaveai/web-sdk/start';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string };

test('SDK_VERSION matches package.json', () => {
  assert.equal(SDK_VERSION, manifest.version);
});

test('SDK_CHANNEL follows the version: -rc.N builds are staging', () => {
  assert.equal(SDK_CHANNEL, /-rc\./.test(manifest.version) ? 'staging' : 'production');
});
