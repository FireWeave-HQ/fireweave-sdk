/**
 * Browser-portability guard (ADR-0009) — the mirror image of the server SDK's
 * `runtime-portability.test.ts`.
 *
 * There, the rule is "no Node globals, because Deno lacks them". Here it is
 * stronger and the reasons are different in kind:
 *
 *  - `process` / `Deno` / `node:` — a browser has none of them, and a bundler
 *    will happily shim `process.env` into a frozen build-time object, so the
 *    breakage is silent rather than loud.
 *  - `posthog-js` and `phc_`/`phs_`/`phx_` key shapes — ADR-0004 blocked a
 *    browser package specifically because of secret-key leakage. ADR-0009
 *    unblocked it on the promise that no code path here ever wants one. This
 *    test is what makes that a property of the package rather than a promise.
 *
 * Static over `src/`, because none of these regressions fail a runtime test:
 * they fail in a customer's bundle, or they do not fail at all and just quietly
 * ship a secret.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', '..', 'src');

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]
  );

const sources = (): Array<{ path: string; text: string }> =>
  walk(srcDir)
    .filter((f) => f.endsWith('.ts'))
    .map((path) => ({ path: relative(srcDir, path), text: readFileSync(path, 'utf8') }));

/** Strip comments so prose naming a global is not treated as a use of it. */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the source scan is not silently empty', () => {
  assert.ok(sources().length >= 8, 'expected the web SDK src/ tree to be scanned');
});

test('no source file reads process', () => {
  const offenders = sources()
    .filter(({ text }) => /\bprocess\s*\./.test(stripComments(text)))
    .map(({ path }) => path);
  assert.deepEqual(
    offenders,
    [],
    'A browser package must not read `process`. Credentials are explicit constructor options (ADR-0009).'
  );
});

test('no source file reads Deno or import.meta.env', () => {
  const offenders = sources()
    .filter(({ text }) => {
      const stripped = stripComments(text);
      return /\bDeno\s*\./.test(stripped) || /import\.meta\.env/.test(stripped);
    })
    .map(({ path }) => path);
  assert.deepEqual(
    offenders,
    [],
    'The SDK never picks up ambient configuration; the embedding app passes it in.'
  );
});

test('no source file imports a node: builtin', () => {
  const offenders = sources()
    .filter(({ text }) => /from\s+['"]node:/.test(stripComments(text)))
    .map(({ path }) => path);
  assert.deepEqual(offenders, [], 'Browser code cannot import Node built-ins.');
});

test('no source file uses the Node-only Buffer global', () => {
  const offenders = sources()
    .filter(({ text }) => /\bBuffer\s*\./.test(stripComments(text)))
    .map(({ path }) => path);
  assert.deepEqual(offenders, [], 'Use TextEncoder for UTF-8 byte length.');
});

test('no source file depends on a vendor analytics SDK', () => {
  const offenders = sources()
    .filter(({ text }) => /posthog/i.test(stripComments(text)))
    .map(({ path }) => path);
  assert.deepEqual(
    offenders,
    [],
    'The browser package speaks only the vendor-neutral Fireweave protocol (ADR-0005/0009).'
  );
});

test('secret key prefixes appear only where they are REJECTED', () => {
  // `hosts.ts` names them to refuse them. Anywhere else, a key prefix in source
  // suggests the package learned to accept one.
  const offenders = sources()
    .filter(({ path }) => path !== 'hosts.ts')
    .filter(({ text }) => /\bph[sxc]_/.test(stripComments(text)))
    .map(({ path }) => path);
  assert.deepEqual(offenders, [], 'Only hosts.ts may mention vendor key prefixes, to reject them.');
});
