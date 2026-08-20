/**
 * Layering guard, mirroring sdks/node/packages/sdk/test/unit/architecture-layers.test.ts:
 *
 *  - the SDK stays dependency-free — `package.json`'s `dependencies` never
 *    grows beyond zero entries (peerDependencies/devDependencies are a
 *    separate, permitted surface; see browser-portability.test.ts for the
 *    wider "no vendor reference" guard);
 *  - `src/domain/` stays pure — it imports nothing from `application/` or
 *    `infrastructure/`, so the same rules/types port to every target
 *    language's validation layer without dragging adapters or runtime
 *    wiring along;
 *  - `src/application/` does not reach into `infrastructure/` at all,
 *    except through the one sanctioned seam: `mode.ts`, the composition
 *    root (its whole job is adapter selection, so its concrete
 *    `infrastructure/adapters/*` and `infrastructure/hosts.js` imports are
 *    exempt wholesale — it is skipped entirely below rather than
 *    allowlisted specifier-by-specifier, mirroring node's treatment of its
 *    own mode.ts).
 *
 * One divergence from node worth naming: node's runtime.ts has a single
 * allowlisted `infrastructure/hosts.js` import (a pure function used for its
 * own host-allowlist config check). Web's `FireweaveWebRuntime` has no such
 * check — mode.ts (the composition root) owns host validation entirely
 * (see mode.ts's module doc comment on why web can't rely on
 * `runtime.initialize()` the way node does) — so web's allowlist is empty.
 * Any `application/` file outside mode.ts reaching into `infrastructure/`
 * is therefore a boundary violation with no exemption, full stop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..', '..');
const domainDir = join(packageRoot, 'src', 'domain');
const applicationDir = join(packageRoot, 'src', 'application');

test('package.json declares zero runtime dependencies', () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  assert.deepEqual(
    Object.keys(manifest.dependencies ?? {}),
    [],
    'the SDK must stay dependency-free: dependencies must be absent or {}'
  );
});

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]
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
      // that walks up a directory ('../application/…', '../infrastructure/…')
      // would cross out of the layer, which is exactly what this guard
      // exists to catch.
      if (!specifier.startsWith('./')) {
        offenders.push(`${relative(domainDir, file)} imports '${specifier}'`);
      }
    }
  }
  assert.deepEqual(offenders, [], `domain/ must not depend on outer layers: ${offenders.join('; ')}`);
});

/**
 * `mode.ts` is the SANCTIONED composition root: the plan places "mode" in
 * `application/` and its defined job is adapter selection, so its concrete
 * `infrastructure/*` imports are expected and exempt wholesale — it is
 * skipped entirely below rather than allowlisted specifier-by-specifier.
 */
const APPLICATION_COMPOSITION_ROOT = 'mode.ts';

/**
 * Every other `application/` file's `infrastructure/` imports must appear
 * here. Empty for web (see the module doc comment above) — unlike node,
 * nothing in `application/` outside `mode.ts` has a legitimate reason to
 * reach into `infrastructure/`.
 */
const APPLICATION_INFRASTRUCTURE_ALLOWLIST: Readonly<Record<string, readonly string[]>> = Object.freeze({});

test('application/ (outside mode.ts, the composition root) does not import infrastructure/ at all', () => {
  const files = walk(applicationDir).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length > 0, 'expected source files under src/application');

  const offenders: string[] = [];
  for (const file of files) {
    const relPath = relative(applicationDir, file);
    if (relPath === APPLICATION_COMPOSITION_ROOT) continue;

    const allowed = APPLICATION_INFRASTRUCTURE_ALLOWLIST[relPath] ?? [];
    const text = readFileSync(file, 'utf8');
    for (const specifier of importSpecifiers(text)) {
      if (specifier.startsWith('../infrastructure/') && !allowed.includes(specifier)) {
        offenders.push(`${relPath} imports '${specifier}'`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `application/ (outside ${APPLICATION_COMPOSITION_ROOT}) must not import infrastructure/: ${offenders.join('; ')}`
  );
});
