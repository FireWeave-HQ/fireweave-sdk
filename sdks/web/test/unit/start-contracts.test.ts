/**
 * The shared start-profile suite (contracts/start/, spec/start-profile.md) on
 * web. Web has only the client profile: client fixtures plus the `any`
 * defineFlags fixtures. Drives the pure policy (src/start/policy.ts) with the
 * input start() builds in src/start/state.ts, compares by the rules in
 * contracts/start/README.md, and writes
 * test/conformance/compatibility-report.start.web.json (gitignored).
 *
 * A case's `build` is what the fireweave() build plugin injected for a release
 * build: FIREWEAVE_BROWSER_KEY, FIREWEAVE_URL and FIREWEAVE_ENV become the
 * injected key, url and environment with those names as their sources. Any
 * other build value (FIREWEAVE_KEY) is never injected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firstOf, resolvePolicy, sourced, type InjectedConfig, type SdkChannel } from '../../src/start/policy.ts';
import { BUILD_ENV } from '../../src/start/names.ts';
import { defineFlags } from '../../src/start/flags.ts';

const LANG = 'web';
const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = join(here, '..', '..', '..', '..', 'contracts', 'start');
const reportPath = join(here, '..', 'conformance', 'compatibility-report.start.web.json');

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

const KNOWN_NAMES = new Set<string>([BUILD_ENV.key, BUILD_ENV.url, BUILD_ENV.environment]);

/**
 * contracts/start/README.md "Comparing results": a build-value name stays; a
 * start({ … }) source becomes `option`; the channel default ('SDK channel (…)')
 * becomes `channel`; no key stays `none`.
 */
function normaliseSource(source: string | undefined): string | undefined {
  if (source === undefined) return undefined;
  if (source === 'none') return 'none';
  if (source.startsWith('SDK channel')) return 'channel';
  if (KNOWN_NAMES.has(source)) return source;
  return 'option';
}

interface Outcome {
  fields: Record<string, unknown>;
  warnings: string[];
  error?: { kind: string; message: string };
}

/** What the fireweave() plugin injects for these build values (node/shared.ts resolveBuild). */
function injectedFrom(build: Record<string, string>): InjectedConfig {
  return {
    v: 1,
    ...(build[BUILD_ENV.key] !== undefined ? { key: build[BUILD_ENV.key], keySource: BUILD_ENV.key } : {}),
    ...(build[BUILD_ENV.url] !== undefined ? { url: build[BUILD_ENV.url], urlSource: BUILD_ENV.url } : {}),
    ...(build[BUILD_ENV.environment] !== undefined
      ? { environment: build[BUILD_ENV.environment], environmentSource: BUILD_ENV.environment }
      : {}),
  };
}

function runResolve(c: Case): Outcome {
  const options = (c.when.options ?? {}) as Record<string, string>;
  const injected = injectedFrom((c.when.build ?? {}) as Record<string, string>);
  const channel = (c.when.channel ?? 'production') as SdkChannel;
  // The same input start() builds in src/start/state.ts, with the case's channel
  // in place of this build's SDK_CHANNEL.
  const r = resolvePolicy({
    mode: options.mode,
    key: firstOf(sourced(options.key, 'start({ key })'), sourced(injected.key, injected.keySource ?? BUILD_ENV.key)),
    url: firstOf(sourced(options.url, 'start({ url })'), sourced(injected.url, injected.urlSource ?? BUILD_ENV.url)),
    environment: firstOf(
      sourced(options.environment, 'start({ environment })'),
      sourced(injected.environment, injected.environmentSource ?? BUILD_ENV.environment),
    ),
    channel,
    keyVariable: BUILD_ENV.key,
    environmentChecked: 'start({ environment }) and the build config',
  });
  // A client profile never throws: a failure result is its Configuration fault.
  if (!r.ok) return { fields: {}, warnings: [], error: { kind: 'Configuration', message: r.message } };
  const cfg = r.config;
  return {
    warnings: [...r.warnings],
    fields: {
      mode: cfg.mode,
      modeSource: cfg.modeSource,
      url: cfg.url,
      urlSource: normaliseSource(cfg.urlSource),
      allowedHosts: cfg.allowedHosts === undefined ? null : [...cfg.allowedHosts],
      keySource: normaliseSource(cfg.keySource),
      environment: cfg.environment,
      environmentSource: normaliseSource(cfg.environmentSource),
    },
  };
}

/**
 * Web's defineFlags rejects a bad flags object with a TypeError naming the
 * entry (the core's FireweaveError carries fixed messages only); start() maps
 * the same rejection to problem 'invalid-flags' and a Configuration status.
 * Only that deliberate rejection counts as the Configuration fault.
 */
function runDefineFlags(c: Case): Outcome {
  try {
    defineFlags(c.when.flags as never);
    return { fields: { ok: true }, warnings: [] };
  } catch (err) {
    if (!(err instanceof TypeError) || !err.message.startsWith('[fireweave]')) throw err;
    return { fields: {}, warnings: [], error: { kind: 'Configuration', message: err.message } };
  }
}

function run(c: Case): Outcome {
  switch (c.when.operation) {
    case 'resolve':
      return runResolve(c);
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
