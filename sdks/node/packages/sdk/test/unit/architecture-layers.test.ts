/**
 * Layering guard (Phase 1.4, IMPLEMENTATION-PLAN.md "Relayer to `domain/` ·
 * `application/` · `infrastructure/`"):
 *
 *  - the SDK stays dependency-free — `package.json`'s `dependencies` never
 *    grows beyond zero entries (peerDependencies/devDependencies are a
 *    separate, permitted surface; see no-vendor-leak.test.ts for the wider
 *    "no vendor reference" guard);
 *  - `src/domain/` stays pure — it imports nothing from `application/` or
 *    `infrastructure/`, so the same rules/types port to every target
 *    language's validation layer without dragging adapters or runtime
 *    wiring along.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..', '..');
const domainDir = join(packageRoot, 'src', 'domain');

test('package.json declares zero runtime dependencies', () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  assert.deepEqual(
    Object.keys(manifest.dependencies ?? {}),
    [],
    'the SDK must stay dependency-free: dependencies must be absent or {}',
  );
});

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );

/** Every `import`/`export ... from '<specifier>'` module specifier in a TS source file. */
const importSpecifiers = (text: string): string[] => {
  const specifiers: string[] = [];
  const pattern = /(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
};

test('domain/ imports nothing from application/ or infrastructure/', () => {
  const files = walk(domainDir).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length > 0, 'expected source files under src/domain');

  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const specifier of importSpecifiers(text)) {
      // domain/ is entirely self-contained: every import must stay inside
      // domain/ (a same-directory or nested './...' specifier). Anything
      // that walks up a directory ('../application/…', '../infrastructure/…',
      // or even '../index.js') would cross out of the layer, which is
      // exactly what this guard exists to catch.
      if (!specifier.startsWith('./')) {
        offenders.push(`${relative(domainDir, file)} imports '${specifier}'`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `domain/ must not depend on outer layers: ${offenders.join('; ')}`,
  );
});
