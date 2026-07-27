import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sdk from '@fireweaveai/sdk';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '..', '..', 'dist');

/** Matches actual module references (import/export/require/import() types), not comments. */
const VENDOR_REF = /(?:from\s+['"]posthog-node['"]|import\(['"]posthog-node['"]\)|require\(['"]posthog-node['"]\)|import\s+['"]posthog-node['"])/;

test('main entrypoint exports contain no posthog identifiers', () => {
  for (const name of Object.keys(sdk)) {
    assert.ok(!/posthog/i.test(name), `unexpected vendor export: ${name}`);
  }
});

test('main entrypoint modules never import posthog-node (even transitively within dist, except the posthog adapter)', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  for (const file of walk(distDir)) {
    if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue;
    const source = readFileSync(file, 'utf8');
    if (file.endsWith(join('adapters', 'posthog.js'))) {
      // The adapter may only load posthog-node lazily (dynamic import at runtime).
      assert.ok(
        !/^\s*import\b[^;]*['"]posthog-node['"]/m.test(source),
        'posthog adapter must not statically import posthog-node',
      );
      continue;
    }
    assert.ok(!VENDOR_REF.test(source), `vendor dependency leaked into ${file}`);
  }
});

test('published API declaration files reference no posthog-node types anywhere', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  const dtsFiles = walk(distDir).filter((f) => f.endsWith('.d.ts'));
  assert.ok(dtsFiles.length > 0, 'expected declaration files in dist');
  for (const file of dtsFiles) {
    const source = readFileSync(file, 'utf8');
    assert.ok(!VENDOR_REF.test(source), `vendor types leaked into ${file}`);
  }
});
