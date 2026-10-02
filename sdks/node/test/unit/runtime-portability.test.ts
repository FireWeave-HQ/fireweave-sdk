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

/**
 * The start profile (docs/adr/0011-start-profile.md) is the one sanctioned
 * reader of the environment and the host name. It does so through two files
 * and nowhere else; the core stays exactly as before (no env, no runtime
 * globals at all).
 */
const START_SEAMS: Readonly<Record<string, string>> = Object.freeze({
  'start/env.ts': 'the only environment reader (Deno.env / process.env)',
  'start/instance.ts': 'the host-name lookup behind fw.instanceKey()',
});
const RUNTIME_GLOBAL = /\b(?:process|Deno)\s*\??\.|\.\s*(?:process|Deno)\b|getBuiltinModule/;

test('no source file reads process.env — the core reads no environment variables', () => {
  const offenders = sources()
    .filter(({ path }) => START_SEAMS[path] === undefined)
    .filter(({ text }) => /\bprocess\s*\.\s*env\b/.test(stripComments(text)))
    .map(({ path }) => path);
  assert.deepEqual(
    offenders,
    [],
    `spec/modes.md: the core reads no environment variables; only ${Object.keys(START_SEAMS).join(', ')} may: ${offenders.join(', ')}`,
  );
});

test('outside the start seams, no source file touches the process or Deno globals', () => {
  const offenders = sources()
    .filter(({ path }) => START_SEAMS[path] === undefined)
    .filter(({ text }) => RUNTIME_GLOBAL.test(stripComments(text)))
    .map(({ path }) => path);
  assert.deepEqual(
    offenders,
    [],
    `runtime globals are confined to ${Object.keys(START_SEAMS).join(', ')}: ${offenders.join(', ')}`,
  );
});

test('the start seams exist, so this guard cannot pass vacuously', () => {
  const paths = new Set(sources().map(({ path }) => path));
  for (const seam of Object.keys(START_SEAMS)) {
    assert.ok(paths.has(seam), `expected ${seam} (${START_SEAMS[seam]})`);
  }
  const env = sources().find(({ path }) => path === 'start/env.ts');
  assert.ok(env !== undefined && RUNTIME_GLOBAL.test(stripComments(env.text)), 'start/env.ts should be the one env reader');
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
