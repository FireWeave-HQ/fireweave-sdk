/**
 * Vendor-leak guard.
 *
 * v2 allowed one carve-out: `dist/adapters/posthog.js` could name `posthog-node`
 * as long as it loaded it lazily. v3 removed that adapter (ADR-0006), so the
 * guard is now absolute — the string `posthog` must not appear anywhere in the
 * published build, in any form: import, type, identifier, or comment.
 *
 * This is the test that keeps the cleanup from silently regressing. If it fails
 * because a vendor name came back, the fix is to remove the vendor reference,
 * not to add an exemption here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sdk from '@fireweaveai/sdk';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '..', '..', 'dist');

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );

test('no export name references a backend vendor', () => {
  for (const name of Object.keys(sdk)) {
    assert.ok(!/posthog/i.test(name), `unexpected vendor export: ${name}`);
  }
});

test('the published build contains no vendor reference at all', () => {
  const files = walk(distDir).filter((f) => f.endsWith('.js') || f.endsWith('.d.ts'));
  assert.ok(files.length > 0, 'expected build output in dist');

  const offenders: string[] = [];
  for (const file of files) {
    if (/posthog/i.test(readFileSync(file, 'utf8'))) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    `vendor reference leaked into: ${offenders.join(', ')}`,
  );
});

test('the published build declares no runtime dependency beyond OpenFeature', () => {
  const manifest = JSON.parse(
    readFileSync(join(here, '..', '..', 'package.json'), 'utf8'),
  ) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    exports?: Record<string, unknown>;
  };

  assert.equal(manifest.dependencies, undefined, 'the SDK must stay dependency-free');
  assert.deepEqual(
    Object.keys(manifest.peerDependencies ?? {}),
    ['@openfeature/server-sdk'],
    'OpenFeature is the only permitted peer dependency',
  );
  assert.deepEqual(
    Object.keys(manifest.exports ?? {}),
    ['.'],
    'the entrypoint is the only export subpath',
  );
});
