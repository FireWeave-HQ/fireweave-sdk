/**
 * The shared start-profile suite (contracts/start/, spec/start-profile.md) on
 * Node: the reference runner. Drives the pure resolver, the instance-key
 * derivation and defineFlags with each case's inputs, compares by the rules in
 * contracts/start/README.md, and writes
 * test/conformance/compatibility-report.start.node.json (gitignored).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStart } from '../../src/start/resolve.ts';
import { envFromBag } from '../../src/start/env.ts';
import { deriveInstanceKey } from '../../src/start/instance.ts';
import { defineFlags } from '../../src/start/flags.ts';
import { isFireweaveError } from '../../src/index.ts';

const LANG = 'node';
const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = join(here, '..', '..', '..', '..', 'contracts', 'start');
const reportPath = join(here, '..', 'conformance', 'compatibility-report.start.node.json');

interface Case {
  name: string;
  appliesTo?: string[];
  when: Record<string, unknown> & { operation: string };
  expect: Record<string, unknown>;
}
interface Fixture {
  id: string;
  profile: string;
  cases: Case[];
  compatibility: Record<string, string>;
}

const fixtures: Fixture[] = readdirSync(contractsDir)
  .filter((f) => f.endsWith('.json') && f !== 'start-fixture.schema.json')
  .sort()
  .map((f) => JSON.parse(readFileSync(join(contractsDir, f), 'utf8')) as Fixture);

/** contracts/start/README.md "Comparing results": source names are normalised. */
function normaliseSource(source: string | undefined, knownNames: Set<string>): string | undefined {
  if (source === undefined) return undefined;
  if (source === 'none') return 'none';
  if (source.startsWith('SDK channel')) return 'channel';
  if (knownNames.has(source)) return source;
  return 'option';
}

interface Outcome {
  fields: Record<string, unknown>;
  warnings: string[];
  error?: { kind: string; message: string };
}

function runResolve(c: Case): Outcome {
  const options = (c.when.options ?? {}) as Record<string, string>;
  const env = (c.when.env ?? {}) as Record<string, string>;
  const channel = (c.when.channel ?? 'production') as 'production' | 'staging';
  const known = new Set(['FIREWEAVE_KEY', 'FIREWEAVE_URL', 'FIREWEAVE_ENV', 'APP_ENV', 'NODE_ENV', 'FW_PROJECT_API_KEY', 'FW_API_URL', 'FW_ATTEST_URL']);
  try {
    const r = resolveStart(
      { mode: options.mode, environment: options.environment, url: options.url, key: options.key },
      envFromBag(env),
      { version: '0.0.0-contract', channel },
    );
    return {
      warnings: [...r.warnings],
      fields: {
        mode: r.mode,
        modeSource: r.modeSource,
        url: r.url,
        urlSource: normaliseSource(r.urlSource, known),
        allowedHosts: r.allowedHosts === undefined ? null : [...r.allowedHosts],
        keySource: normaliseSource(r.keySource, known),
        environment: r.environment,
        environmentSource: normaliseSource(r.environmentSource, known),
      },
    };
  } catch (err) {
    if (!isFireweaveError(err)) throw err;
    return { fields: {}, warnings: [], error: { kind: err.kind, message: err.message } };
  }
}

function runInstanceKey(c: Case): Outcome {
  const options = (c.when.options ?? {}) as Record<string, string>;
  const env = { ...((c.when.env ?? {}) as Record<string, string>) };
  // Node reads HOSTNAME first; a null host leaves it unset (the process host may then apply,
  // which still satisfies the random case's `inst_` prefix).
  if (typeof c.when.hostName === 'string') env.HOSTNAME = c.when.hostName;
  const key = deriveInstanceKey(options.instanceId?.trim() ? options.instanceId : undefined, envFromBag(env));
  return { fields: { value: key.value }, warnings: [] };
}

function runDefineFlags(c: Case): Outcome {
  try {
    defineFlags(c.when.flags as never);
    return { fields: { ok: true }, warnings: [] };
  } catch (err) {
    if (!isFireweaveError(err)) throw err;
    return { fields: {}, warnings: [], error: { kind: err.kind, message: err.message } };
  }
}

function run(c: Case): Outcome {
  switch (c.when.operation) {
    case 'resolve':
      return runResolve(c);
    case 'instanceKey':
      return runInstanceKey(c);
    case 'defineFlags':
      return runDefineFlags(c);
    default:
      throw new Error(`operation ${c.when.operation} is not applicable to ${LANG}`);
  }
}

/** Returns the list of differences; empty when the case passes. */
function compare(expect: Record<string, unknown>, out: Outcome): string[] {
  const diffs: string[] = [];
  const err = expect.error as { kind: string; mentions?: string[]; mustNotMention?: string[] } | undefined;
  if (err !== undefined) {
    if (out.error === undefined) return [`expected a ${err.kind} error, got ${JSON.stringify(out.fields)}`];
    if (out.error.kind !== err.kind) diffs.push(`error kind ${out.error.kind}, expected ${err.kind}`);
    for (const n of err.mentions ?? []) if (!out.error.message.includes(n)) diffs.push(`error does not mention ${n}: ${out.error.message}`);
    for (const n of err.mustNotMention ?? []) if (out.error.message.includes(n)) diffs.push(`error mentions ${n}`);
    return diffs;
  }
  if (out.error !== undefined) return [`unexpected ${out.error.kind} error: ${out.error.message}`];
  for (const [field, want] of Object.entries(expect)) {
    if (field === 'warnings') {
      const w = want as { mention?: string[]; mustNotMention?: string[] };
      for (const n of w.mention ?? []) if (!out.warnings.some((l) => l.includes(n))) diffs.push(`no warning mentions ${n}`);
      for (const n of w.mustNotMention ?? []) if (out.warnings.some((l) => l.includes(n))) diffs.push(`a warning mentions ${n}`);
      continue;
    }
    if (field === 'prefix') {
      const v = String(out.fields.value ?? '');
      if (!v.startsWith(want as string)) diffs.push(`value ${v} does not start with ${want}`);
      continue;
    }
    const got = out.fields[field] ?? null;
    if (field === 'allowedHosts' && Array.isArray(want) && Array.isArray(got)) {
      const a = new Set(want as string[]);
      const b = new Set(got as string[]);
      if (a.size !== b.size || [...a].some((h) => !b.has(h))) diffs.push(`allowedHosts ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
      continue;
    }
    if (JSON.stringify(got) !== JSON.stringify(want)) diffs.push(`${field} ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
  return diffs;
}

interface CaseResult {
  name: string;
  status: 'pass' | 'fail' | 'not-applicable';
  message?: string;
}

const results = fixtures.map((fx) => {
  const declared = fx.compatibility[LANG];
  if (declared === 'not-applicable') return { fixtureId: fx.id, status: 'not-applicable', cases: [] as CaseResult[], message: '' };
  const cases: CaseResult[] = fx.cases.map((c) => {
    if (c.appliesTo !== undefined && !c.appliesTo.includes(LANG)) return { name: c.name, status: 'not-applicable' };
    const diffs = compare(c.expect, run(c));
    return diffs.length === 0 ? { name: c.name, status: 'pass' } : { name: c.name, status: 'fail', message: diffs.join('; ') };
  });
  const failed = cases.filter((c) => c.status === 'fail');
  return {
    fixtureId: fx.id,
    status: failed.length === 0 ? 'pass' : 'fail',
    cases,
    message: failed.map((c) => `${c.name}: ${c.message}`).join(' | '),
  };
});

writeFileSync(reportPath, `${JSON.stringify({ language: LANG, suite: 'start', results }, null, 2)}\n`);

test('contracts/start has fixtures', () => {
  assert.ok(fixtures.length >= 10, 'expected the shared start-profile suite');
});

for (const r of results) {
  const fx = fixtures.find((f) => f.id === r.fixtureId)!;
  if (fx.compatibility[LANG] !== 'pass') continue;
  test(`contracts/start ${r.fixtureId}`, () => {
    assert.equal(r.status, 'pass', r.message);
  });
}
