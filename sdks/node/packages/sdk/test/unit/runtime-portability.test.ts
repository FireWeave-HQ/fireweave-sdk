/**
 * Runtime-portability guard (ADR-0008).
 *
 * The SDK runs on Node, Bun, and Deno. Bun and Deno both provide `fetch`,
 * `AbortController`, `URL`, `setTimeout`, and `TextEncoder`, but NOT the Node
 * globals `Buffer` and `process` in native (non-npm-compat) code.
 *
 * A `Buffer.` reference reintroduced into src would work fine on Node and
 * Bun and fail only on Deno — a failure mode that CI on Node alone cannot
 * see. This test is a static check on the published build so the regression
 * is caught at the source.
 *
 * `src/infrastructure/env.ts` (the former `readEnv()` runtime-agnostic
 * environment read) was deleted: spec/modes.md "The SDK reads no
 * environment variables" is unscoped, so the SDK has no sanctioned reason to
 * read `process.env` anywhere at all (controller ruling, Task 4 fix round).
 * The `process.env` check below is therefore unconditional — no per-file
 * exemption remains.
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

test('no source file reads process.env — the SDK reads no environment variables', () => {
  const offenders = sources()
    .filter(({ text }) => /\bprocess\s*\.\s*env\b/.test(stripComments(text)))
    .map(({ path }) => path);
  assert.deepEqual(
    offenders,
    [],
    `spec/modes.md: the SDK reads no environment variables (unscoped): ${offenders.join(', ')}`,
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
