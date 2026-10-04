/**
 * Layering guard, mirroring sdks/node/test/unit/architecture-layers.test.ts:
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

/** Every `import`/`export ... from '<specifier>'` and side-effect `import '<specifier>'` in a TS source file. */
const importSpecifiers = (text: string): string[] => {
  const specifiers: string[] = [];
  const pattern = /(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const specifier = match[1] ?? match[2];
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

/**
 * The start profile (src/start/, ADR-0012) is a layer OVER the core: it may use
 * the public barrel and its own files only, and the core must never depend on
 * it, so `initFireweave` stays policy-free.
 */
const startDir = join(packageRoot, 'src', 'start');
const CORE_LAYERS = ['domain', 'application', 'infrastructure'];

/** Strip comments so doc examples are not read as imports. */
const codeOnly = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('start/ imports only the public barrel and its own files', () => {
  const files = walk(startDir).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 6, 'expected the start profile under src/start');
  const offenders: string[] = [];
  for (const file of files) {
    for (const specifier of importSpecifiers(codeOnly(readFileSync(file, 'utf8')))) {
      if (specifier !== '../index.js' && !/^\.\/[a-z-]+\.js$/.test(specifier)) {
        offenders.push(`${relative(startDir, file)} imports '${specifier}'`);
      }
    }
  }
  assert.deepEqual(offenders, [], `start/ must use the public API only: ${offenders.join('; ')}`);
});

test('the core never imports start/', () => {
  const offenders: string[] = [];
  for (const layer of CORE_LAYERS) {
    for (const file of walk(join(packageRoot, 'src', layer)).filter((f) => f.endsWith('.ts'))) {
      for (const specifier of importSpecifiers(codeOnly(readFileSync(file, 'utf8')))) {
        if (specifier.includes('/start/') || specifier.startsWith('../start')) offenders.push(`${layer}/${relative(join(packageRoot, 'src', layer), file)} imports '${specifier}'`);
      }
    }
  }
  assert.deepEqual(offenders, [], `the core must not depend on the start profile: ${offenders.join('; ')}`);
});

/**
 * node/ is build tooling that runs in Node at config time. It may use node:
 * built-ins, its own files and the three pure start modules, and must never
 * import vite statically (vite is an optional peer, loaded lazily).
 */
const nodeDir = join(packageRoot, 'node');
const NODE_SHARED_FROM_SRC = ['../src/start/policy.js', '../src/start/names.js', '../src/start/build-info.js'];

test('node/ imports only node: built-ins, its own files and the pure start modules', () => {
  const files = walk(nodeDir).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 3, 'expected the build helpers under node/');
  const offenders: string[] = [];
  for (const file of files) {
    for (const specifier of importSpecifiers(codeOnly(readFileSync(file, 'utf8')))) {
      const ok = specifier.startsWith('node:') || /^\.\/[a-z-]+\.js$/.test(specifier) || NODE_SHARED_FROM_SRC.includes(specifier);
      if (!ok) offenders.push(`${relative(nodeDir, file)} imports '${specifier}'`);
    }
  }
  assert.deepEqual(offenders, [], `node/ dependency rule: ${offenders.join('; ')}`);
});

test('the start modules node/ shares import nothing outside start/', () => {
  const offenders: string[] = [];
  for (const shared of NODE_SHARED_FROM_SRC) {
    const file = join(nodeDir, shared.replace(/\.js$/, '.ts'));
    for (const specifier of importSpecifiers(codeOnly(readFileSync(file, 'utf8')))) {
      if (!/^\.\/[a-z-]+\.js$/.test(specifier)) offenders.push(`${shared} imports '${specifier}'`);
      else if (!NODE_SHARED_FROM_SRC.includes(`../src/start/${specifier.slice(2)}`)) offenders.push(`${shared} imports '${specifier}', which node/ cannot share`);
    }
  }
  assert.deepEqual(offenders, [], `policy, names and build-info must stay pure: ${offenders.join('; ')}`);
});

test('package exports are pinned', () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    exports: Record<string, unknown>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  assert.deepEqual(Object.keys(manifest.exports), ['.', './start', './vite', './define']);
  assert.equal(manifest.peerDependenciesMeta?.['vite']?.optional, true, 'vite must stay an optional peer');
});
