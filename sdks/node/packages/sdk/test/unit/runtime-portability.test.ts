/**
 * Runtime-portability guard (ADR-0008).
 *
 * The SDK runs on Node, Bun, and Deno. Bun and Deno both provide `fetch`,
 * `AbortController`, `URL`, `setTimeout`, and `TextEncoder`, but NOT the Node
 * globals `Buffer` and `process` in native (non-npm-compat) code.
 *
 * A `Buffer.` or bare `process.env` reference reintroduced into src would work
 * fine on Node and Bun and fail only on Deno — a failure mode that CI on Node
 * alone cannot see. This test is a static check on the published build so the
 * regression is caught at the source.
 *
 * Environment reads must route through `readEnv()` in
 * src/infrastructure/env.ts, which also survives Deno without
 * `--allow-env`.
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
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );

const sources = (): Array<{ path: string; text: string }> =>
  walk(srcDir)
    .filter((f) => f.endsWith('.ts'))
    .map((path) => ({ path: relative(srcDir, path), text: readFileSync(path, 'utf8') }));

/** Strips comments so prose mentioning a global is not treated as a use. */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('no source file uses the Node-only Buffer global', () => {
  const offenders = sources()
    .filter(({ text }) => /\bBuffer\s*\./.test(stripComments(text)))
    .map(({ path }) => path);
  assert.deepEqual(
    offenders,
    [],
    `Buffer is unavailable in native Deno — use TextEncoder instead: ${offenders.join(', ')}`,
  );
});

test('environment reads go through readEnv(), never process.env directly', () => {
  const offenders = sources()
    .filter(({ path }) => path !== 'infrastructure/env.ts')
    .filter(({ text }) => /\bprocess\s*\.\s*env\b/.test(stripComments(text)))
    .map(({ path }) => path);
  assert.deepEqual(
    offenders,
    [],
    `use readEnv() from src/env.ts so Deno (and Deno without --allow-env) works: ${offenders.join(', ')}`,
  );
});

test('no source file imports a node: builtin', () => {
  const offenders = sources()
    .filter(({ text }) => /from\s+['"]node:/.test(stripComments(text)))
    .map(({ path }) => path);
  assert.deepEqual(
    offenders,
    [],
    `node: builtins tie the SDK to one runtime: ${offenders.join(', ')}`,
  );
});

test('readEnv tolerates a runtime that offers neither process nor Deno', async () => {
  const { readEnv } = (await import('../../src/infrastructure/env.js')) as {
    readEnv: (name: string) => string | undefined;
  };
  const originalProcess = (globalThis as { process?: unknown }).process;
  try {
    delete (globalThis as { process?: unknown }).process;
    assert.equal(readEnv('FW_API_URL'), undefined, 'must return undefined, not throw');
  } finally {
    (globalThis as { process?: unknown }).process = originalProcess;
  }
});

test('readEnv tolerates a Deno-like env that throws on missing permission', async () => {
  const { readEnv } = (await import('../../src/infrastructure/env.js')) as {
    readEnv: (name: string) => string | undefined;
  };
  const originalProcess = (globalThis as { process?: unknown }).process;
  const originalDeno = (globalThis as { Deno?: unknown }).Deno;
  try {
    delete (globalThis as { process?: unknown }).process;
    (globalThis as { Deno?: unknown }).Deno = {
      env: {
        get(): string | undefined {
          throw new Error('Requires env access, run again with the --allow-env flag');
        },
      },
    };
    assert.equal(readEnv('FW_API_URL'), undefined, 'a denied permission is absence, not failure');
  } finally {
    (globalThis as { process?: unknown }).process = originalProcess;
    if (originalDeno === undefined) delete (globalThis as { Deno?: unknown }).Deno;
    else (globalThis as { Deno?: unknown }).Deno = originalDeno;
  }
});
