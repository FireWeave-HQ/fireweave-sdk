/**
 * Fireweave web conformance runner.
 *
 * Loads every fixture in `contracts/web/`, drives it through the real
 * `FireweaveWebRuntime` + `FireweaveWebProvider`, and diffs the result against
 * the fixture's `expect`. Writes `compatibility-report.web.json` and exits
 * non-zero on any failure.
 *
 * ## Why a separate suite (ADR-0009)
 *
 * The shared 65 fixtures encode ASYNC server semantics — awaited evaluation,
 * per-call round trips, lifecycle gating around a promise. A synchronous
 * cache-read surface does not answer those questions, so forcing web through
 * them would produce a wall of pre-declared skips. A skip that asserts nothing
 * is worse than an absent fixture, because it reads as coverage.
 *
 * These fixtures instead pin what is genuinely web: prefetch-on-initialize,
 * the synchronous read contract, context-change re-prefetch, stale-on-timeout,
 * and the security rules that let a browser package exist at all.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FireweaveRemoteWebAdapter,
  FireweaveWebProvider,
  FireweaveWebRuntime,
  InMemoryWebAdapter,
  isFireweaveError,
} from '@fireweaveai/web-sdk';
import type {
  InMemoryFlagDefinition,
  WebBackendAdapter,
  ExpectedFlagType,
} from '@fireweaveai/web-sdk';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = join(HERE, '..', '..', '..', '..', 'contracts', 'web');

interface Fixture {
  id: string;
  suite: string;
  description: string;
  given: {
    providerState?: string;
    flags?: Record<string, InMemoryFlagDefinition & { matchTargetingKey?: string }>;
  };
  when: {
    operation: string;
    flagKey?: string;
    flagType?: ExpectedFlagType;
    defaultValue?: unknown;
    invocationContext?: Record<string, unknown>;
    nextContext?: Record<string, unknown>;
    apiUrl?: string;
    apiKey?: string;
  };
  expect: Record<string, unknown>;
}

interface Outcome {
  id: string;
  status: 'pass' | 'fail';
  detail?: string;
}

/** An adapter whose prefetch never settles — drives the stale-on-timeout path. */
const hangingAdapter: WebBackendAdapter = {
  name: 'other',
  async initialize() {},
  prefetch: () => new Promise(() => {}),
  async shutdown() {},
  features: () => ({ remoteEvaluation: true }),
};

function loadFixtures(): Fixture[] {
  return readdirSync(CONTRACTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(CONTRACTS_DIR, f), 'utf8')) as Fixture);
}

async function makeRuntime(fixture: Fixture): Promise<FireweaveWebRuntime> {
  const hangs = fixture.given.providerState === 'HANGS';
  const adapter: WebBackendAdapter = hangs
    ? hangingAdapter
    : new InMemoryWebAdapter({ flags: fixture.given.flags ?? {} });

  const runtime = new FireweaveWebRuntime(adapter, {
    globalContext: (fixture.when.invocationContext ?? {}) as never,
    flagsReadyTimeoutMs: hangs ? 25 : 2_000,
  });
  if (fixture.given.providerState !== 'UNINITIALIZED') {
    await runtime.initialize();
  }
  return runtime;
}

function diff(actual: Record<string, unknown>, expected: Record<string, unknown>): string | undefined {
  for (const [key, want] of Object.entries(expected)) {
    const got = actual[key];
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      return `${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`;
    }
  }
  return undefined;
}

async function runFixture(fixture: Fixture): Promise<Outcome> {
  const { operation } = fixture.when;

  if (operation === 'constructRemoteAdapter' || operation === 'initializeRemoteAdapter') {
    try {
      const adapter = new FireweaveRemoteWebAdapter({
        apiUrl: fixture.when.apiUrl as string,
        apiKey: fixture.when.apiKey as string,
      });
      if (operation === 'initializeRemoteAdapter') await adapter.initialize();
      const detail = diff({ throws: false }, fixture.expect);
      return detail === undefined
        ? { id: fixture.id, status: 'pass' }
        : { id: fixture.id, status: 'fail', detail };
    } catch (err) {
      const actual = {
        throws: true,
        errorKind: isFireweaveError(err) ? err.kind : 'Unknown',
      };
      const detail = diff(actual, fixture.expect);
      return detail === undefined
        ? { id: fixture.id, status: 'pass' }
        : { id: fixture.id, status: 'fail', detail };
    }
  }

  const runtime = await makeRuntime(fixture);
  const flagKey = fixture.when.flagKey as string;
  const flagType = fixture.when.flagType as ExpectedFlagType;
  const defaultValue = fixture.when.defaultValue as never;

  if (operation === 'assertSyncProvider') {
    const provider = new FireweaveWebProvider(runtime);
    const details = provider.resolveBooleanEvaluation(
      flagKey,
      defaultValue,
      (fixture.when.invocationContext ?? {}) as never
    );
    const actual = { isPromise: details instanceof Promise, value: details.value };
    const detail = diff(actual, fixture.expect);
    await runtime.shutdown();
    return detail === undefined
      ? { id: fixture.id, status: 'pass' }
      : { id: fixture.id, status: 'fail', detail };
  }

  let changedKeys: readonly string[] | undefined;
  if (operation === 'setContextThenEvaluate') {
    changedKeys = await runtime.setContext(fixture.when.nextContext as never);
  }

  const decision = runtime.evaluateSync(flagKey, flagType, defaultValue);
  const actual: Record<string, unknown> = {
    value: decision.value,
    reason: decision.reason,
    lifecycle: runtime.getState(),
  };
  if (decision.variant !== undefined) actual['variant'] = decision.variant;
  if (decision.errorCode !== undefined) actual['errorCode'] = decision.errorCode;
  if (changedKeys !== undefined) actual['changedKeys'] = [...changedKeys];

  const detail = diff(actual, fixture.expect);
  await runtime.shutdown();
  return detail === undefined
    ? { id: fixture.id, status: 'pass' }
    : { id: fixture.id, status: 'fail', detail };
}

const fixtures = loadFixtures();
if (fixtures.length === 0) {
  console.error('no web fixtures found — the runner would report a vacuous pass');
  process.exit(1);
}

const outcomes: Outcome[] = [];
for (const fixture of fixtures) {
  try {
    outcomes.push(await runFixture(fixture));
  } catch (err) {
    outcomes.push({
      id: fixture.id,
      status: 'fail',
      detail: `threw: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

for (const o of outcomes) {
  console.log(`${o.status === 'pass' ? 'PASS' : 'FAIL'}  ${o.id}${o.detail ? ` — ${o.detail}` : ''}`);
}

const passed = outcomes.filter((o) => o.status === 'pass').length;
const failed = outcomes.length - passed;

const reportPath = join(HERE, 'compatibility-report.web.json');
writeFileSync(
  reportPath,
  `${JSON.stringify(
    { language: 'web', suite: 'web', total: outcomes.length, passed, failed, outcomes },
    null,
    2
  )}\n`
);

console.log(`\n${passed} passed, ${failed} failed (report: ${reportPath})`);
if (failed > 0) process.exit(1);
