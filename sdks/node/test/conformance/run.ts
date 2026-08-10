/**
 * Fireweave Node conformance runner (contracts/harness.md).
 *
 * Loads all contracts/{evaluation,context,lifecycle,faults,security,extensions}
 * fixtures, provisions `given`, invokes `when` through the real OpenFeature
 * client + FireweaveProvider, normalizes actual output, diffs against `expect`,
 * and writes compatibility-report.node.json. Exits non-zero on any fail.
 *
 * Backends:
 *  - evaluation/context/lifecycle/security/extensions → InMemoryAdapter from given.flags
 *  - faults (HTTP semantics) → FireweaveRemoteAdapter against the test-server's
 *    Fireweave-native route (POST /v1/flags/evaluate), fault scope 'evaluate'
 *    (fault-stale-cache runs on the InMemoryAdapter: cache staleness is
 *    provisioned directly per given.flags.fromCache + providerState STALE)
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenFeature } from '@openfeature/server-sdk';
import {
  FireweaveClient,
  FireweaveProvider,
  FireweaveRemoteAdapter,
  FireweaveRuntime,
  InMemoryAdapter,
  isFireweaveError,
  resolvedContextView,
  type BackendAdapter,
  type ContextLimits,
  type Decision,
  type FireweaveErrorKind,
  type FireweaveRuntimeConfig,
  type InMemoryFlagDefinition,
  type JsonValue,
  type LifecycleState,
} from '@fireweaveai/sdk';
// The test-server stub is plain JS by design (test-server/implementation/PLAN.md).
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- no type declarations for the stub
import { startTestServer } from '../../../../test-server/implementation/server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = join(HERE, '..', '..', '..', '..', 'contracts');
const SUITES = ['evaluation', 'context', 'lifecycle', 'faults', 'security', 'extensions'] as const;

interface Fixture {
  id: string;
  suite: string;
  description: string;
  given: {
    providerState?: string;
    flags?: Record<string, InMemoryFlagDefinition>;
    config?: Record<string, JsonValue>;
    globalContext?: Record<string, JsonValue>;
    clientContext?: Record<string, JsonValue>;
    fault?: { mode: string; status?: number; delayMs?: number; body?: string; quotaLimited?: string[]; applyTo?: string };
    domains?: Record<string, { providerState?: string; flags?: Record<string, InMemoryFlagDefinition> }>;
    replacement?: { flags?: Record<string, InMemoryFlagDefinition> };
    extensions?: Record<string, boolean>;
    releaseContext?: Record<string, JsonValue>;
    releaseStatus?: string;
    exposureQueue?: Array<Record<string, JsonValue>>;
  };
  when: Record<string, JsonValue> & { operation: string };
  expect: Record<string, JsonValue>;
  /** Multi-case fixtures (contracts/README.md): each case runs fresh. */
  cases?: Array<{
    name: string;
    given?: Partial<Fixture['given']>;
    when: Record<string, JsonValue> & { operation: string };
    expect: Record<string, JsonValue>;
  }>;
  compatibility: Record<string, string>;
  limitations: Record<string, string>;
}

interface ReportRow {
  fixtureId: string;
  suite: string;
  language: 'node';
  status: 'pass' | 'fail' | 'skipped-with-documented-limitation';
  limitation: string | null;
  message: string | null;
}

type ActualOutput = Record<string, unknown>;

// ---------------------------------------------------------------------------
// helpers

function loadFixtures(): Fixture[] {
  const fixtures: Fixture[] = [];
  for (const suite of SUITES) {
    const dir = join(CONTRACTS_DIR, suite);
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith('.json')) continue;
      fixtures.push(JSON.parse(readFileSync(join(dir, file), 'utf8')) as Fixture);
    }
  }
  return fixtures;
}

/**
 * Fixture context → OpenFeature context. The canonical {targetingKey, attributes}
 * bag shape is passed through untouched: the SDK understands it natively, and
 * flattening would let attributes.targetingKey collide with the real targeting
 * key (ctx-reserved-keys-rejected).
 */
function toOFContext(ctx: Record<string, JsonValue> | undefined): Record<string, JsonValue> {
  if (ctx === undefined) return {};
  return ctx;
}

/** Map a fixture fault declaration to the FireweaveError kind it must produce. */
function faultToErrorKind(fault: { mode: string; status?: number }): FireweaveErrorKind {
  switch (fault.mode) {
    case 'httpStatus': {
      const status = fault.status ?? 500;
      if (status === 401) return 'Authentication';
      if (status === 403) return 'Authorization';
      if (status === 429) return 'RateLimited';
      return 'BackendUnavailable';
    }
    case 'networkError':
    case 'offline':
      return 'Network';
    case 'timeout':
      return 'Timeout';
    case 'invalidJson':
    case 'malformedJson':
    case 'truncated':
      return 'MalformedResponse';
    default:
      return 'Internal';
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    return (
      ak.length === bk.length &&
      ak.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
    );
  }
  return false;
}

const META_EXPECT_KEYS = new Set(['errorMessageMustNotContain', 'recordedMessageMustNotContain']);

/**
 * Subset match (harness.md, getCapabilities exception): every declared key
 * must match exactly; undeclared keys in `actual` are permitted.
 */
function subsetMatch(expected: unknown, actual: unknown): boolean {
  if (
    expected !== null &&
    actual !== null &&
    typeof expected === 'object' &&
    typeof actual === 'object' &&
    !Array.isArray(expected) &&
    !Array.isArray(actual)
  ) {
    return Object.entries(expected as Record<string, unknown>).every(([k, v]) =>
      subsetMatch(v, (actual as Record<string, unknown>)[k]),
    );
  }
  return deepEqual(expected, actual);
}

/** Compare expect vs actual per the normative comparator (contracts/README.md). */
function diff(
  expected: Record<string, JsonValue>,
  actual: ActualOutput,
  subsetKeys: readonly string[] = [],
): string[] {
  const failures: string[] = [];
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (META_EXPECT_KEYS.has(key)) continue;
    const actualValue = actual[key];
    if (expectedValue === null) {
      if (actualValue !== null && actualValue !== undefined) {
        failures.push(`${key}: expected null, got ${JSON.stringify(actualValue)}`);
      }
      continue;
    }
    if (subsetKeys.includes(key)) {
      if (!subsetMatch(expectedValue, actualValue)) {
        failures.push(
          `${key}: expected subset ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualValue)}`,
        );
      }
      continue;
    }
    if (!deepEqual(actualValue ?? null, expectedValue)) {
      failures.push(`${key}: expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualValue)}`);
    }
  }
  const mustNotContain = expected['errorMessageMustNotContain'];
  if (Array.isArray(mustNotContain)) {
    const message = typeof actual['errorMessage'] === 'string' ? actual['errorMessage'] : '';
    for (const needle of mustNotContain) {
      if (typeof needle === 'string' && message.includes(needle)) {
        failures.push(`errorMessage must not contain ${JSON.stringify(needle)}`);
      }
    }
  }
  const recordedMustNot = expected['recordedMessageMustNotContain'];
  if (Array.isArray(recordedMustNot)) {
    const recorded = typeof actual['recordedMessage'] === 'string' ? actual['recordedMessage'] : '';
    for (const needle of recordedMustNot) {
      if (typeof needle === 'string' && recorded.includes(needle)) {
        failures.push(`recorded message must not contain ${JSON.stringify(needle)}`);
      }
    }
  }
  return failures;
}

function lifecycleToFixtureState(state: LifecycleState): string {
  switch (state) {
    case 'READY':
      return 'READY';
    case 'STALE':
      return 'STALE';
    case 'FATAL':
      return 'FATAL';
    case 'ERROR':
      return 'ERROR';
    case 'SHUTDOWN':
      return 'CLOSED';
    default:
      return 'NOT_READY';
  }
}

function runtimeConfigFrom(config: Record<string, JsonValue> | undefined): FireweaveRuntimeConfig {
  const out: FireweaveRuntimeConfig = {};
  if (config === undefined) return out;
  if (typeof config['projectApiKey'] === 'string') out.projectApiKey = config['projectApiKey'];
  if (typeof config['host'] === 'string') out.host = config['host'];
  if (Array.isArray(config['allowedHosts'])) out.allowedHosts = config['allowedHosts'] as string[];
  if (config['requireTargetingKey'] === true) out.requireTargetingKey = true;
  if (Array.isArray(config['reservedAttributeKeys'])) {
    out.reservedAttributeKeys = config['reservedAttributeKeys'] as string[];
  }
  const limits = config['limits'];
  if (limits !== null && typeof limits === 'object' && !Array.isArray(limits)) {
    out.limits = limits as Partial<ContextLimits>;
  }
  return out;
}

/** Wrap an adapter's resolve() with a call counter (security networkCalls checks). */
function withResolveCounter(adapter: BackendAdapter): { adapter: BackendAdapter; count: () => number } {
  let calls = 0;
  const wrapped: BackendAdapter = {
    name: adapter.name,
    initialize: (signal) => adapter.initialize(signal),
    resolve: (flagKey, context, options) => {
      calls += 1;
      return adapter.resolve(flagKey, context, options);
    },
    shutdown: () => adapter.shutdown(),
    flush: adapter.flush !== undefined ? () => adapter.flush!() : undefined,
    recordExposure: adapter.recordExposure !== undefined ? (e) => adapter.recordExposure!(e) : undefined,
    features: () => adapter.features(),
  } as BackendAdapter;
  return { adapter: wrapped, count: () => calls };
}

async function provisionState(runtime: FireweaveRuntime, providerState: string | undefined): Promise<void> {
  switch (providerState) {
    case 'READY':
      await runtime.initialize();
      return;
    case 'STALE':
      await runtime.initialize();
      runtime.markStale();
      return;
    case 'CLOSED':
      await runtime.initialize().catch(() => undefined);
      await runtime.shutdown();
      return;
    case 'NOT_READY':
    case undefined:
      return;
    default:
      return;
  }
}

let domainCounter = 0;
const uniqueDomain = (id: string): string => `${id}-${(domainCounter += 1)}`;

async function evaluateThroughOpenFeature(
  domain: string,
  provider: FireweaveProvider,
  when: { flagKey: string; flagType: string; defaultValue: JsonValue; context: Record<string, JsonValue> },
): Promise<ActualOutput> {
  await OpenFeature.setProviderAndWait(domain, provider);
  const client = OpenFeature.getClient(domain);
  const ofContext = when.context;
  let details: {
    value: JsonValue;
    variant?: string;
    reason?: string;
    errorCode?: string;
    errorMessage?: string;
    flagMetadata?: Record<string, unknown>;
  };
  switch (when.flagType) {
    case 'boolean':
      details = await client.getBooleanDetails(when.flagKey, when.defaultValue as boolean, ofContext);
      break;
    case 'string':
      details = await client.getStringDetails(when.flagKey, when.defaultValue as string, ofContext);
      break;
    case 'integer':
    case 'float':
      details = await client.getNumberDetails(when.flagKey, when.defaultValue as number, ofContext);
      break;
    case 'object':
      details = (await client.getObjectDetails(
        when.flagKey,
        when.defaultValue as Record<string, JsonValue>,
        ofContext,
      )) as typeof details;
      break;
    default:
      throw new Error(`unsupported flagType ${when.flagType}`);
  }
  return {
    value: details.value,
    variant: details.variant ?? null,
    reason: details.reason ?? null,
    errorCode: details.errorCode ?? null,
    errorMessage: details.errorMessage ?? null,
    flagMetadata: details.flagMetadata ?? {},
  };
}

// ---------------------------------------------------------------------------
// per-suite executors

async function runEvaluateFixture(fixture: Fixture): Promise<ActualOutput> {
  const given = fixture.given;
  const when = fixture.when;

  // Multi-domain lifecycle fixture support.
  if (given.domains !== undefined) {
    const requestedDomain = when['domain'] as string;
    let output: ActualOutput = {};
    for (const [domainName, domainGiven] of Object.entries(given.domains)) {
      const adapter = new InMemoryAdapter({ flags: domainGiven.flags ?? {} });
      const runtime = new FireweaveRuntime(adapter);
      await provisionState(runtime, domainGiven.providerState);
      const provider = new FireweaveProvider(runtime);
      const domain = uniqueDomain(`${fixture.id}-${domainName}`);
      if (domainName === requestedDomain) {
        output = await evaluateThroughOpenFeature(domain, provider, {
          flagKey: when['flagKey'] as string,
          flagType: when['flagType'] as string,
          defaultValue: when['defaultValue'] as JsonValue,
          context: toOFContext(when['invocationContext'] as Record<string, JsonValue> | undefined),
        });
      } else {
        await OpenFeature.setProviderAndWait(domain, provider);
      }
    }
    return output;
  }

  const config = runtimeConfigFrom(given.config);
  const gateNeverResolves = new Promise<void>(() => undefined);
  const adapterOptions =
    given.providerState === 'NOT_READY'
      ? { flags: given.flags ?? {}, initGate: { promise: gateNeverResolves } }
      : { flags: given.flags ?? {} };
  const baseAdapter = new InMemoryAdapter(adapterOptions);
  // Security-suite fixtures declare protocol faults but run on the in-memory
  // adapter: model them as thrown FireweaveErrors of the equivalent kind.
  // Faults scoped to other endpoints (e.g. definitions polling in
  // fault-stale-cache) do not affect evaluation reads.
  if (given.fault !== undefined && (given.fault.applyTo === undefined || given.fault.applyTo === 'flags')) {
    baseAdapter.setFault({ kind: faultToErrorKind(given.fault) });
  }
  const { adapter, count } = withResolveCounter(baseAdapter);
  const runtime = new FireweaveRuntime(adapter, config);
  if (given.globalContext !== undefined) runtime.setGlobalContext(given.globalContext);
  if (given.clientContext !== undefined) runtime.setClientContext(given.clientContext);

  if (given.providerState === 'NOT_READY') {
    // Kick off init (it blocks forever on the gate → INITIALIZING → NotReady decisions).
    void runtime.initialize().catch(() => undefined);
  } else {
    await provisionState(runtime, given.providerState);
  }

  const provider = new FireweaveProvider(runtime, {
    includePayload: (when['options'] as { includePayload?: boolean } | undefined)?.includePayload === true,
  });

  const invocationContext = when['invocationContext'] as Record<string, JsonValue> | undefined;
  const callerContext = toOFContext(invocationContext);
  const output = await evaluateThroughOpenFeature(uniqueDomain(fixture.id), provider, {
    flagKey: when['flagKey'] as string,
    flagType: when['flagType'] as string,
    defaultValue: when['defaultValue'] as JsonValue,
    context: callerContext,
  });

  if (fixture.expect['contextSnapshotAfter'] !== undefined) {
    // Report the caller's context object as observed after evaluation.
    const snapshot: Record<string, JsonValue> = {};
    if (typeof callerContext['targetingKey'] === 'string') {
      snapshot['targetingKey'] = callerContext['targetingKey'];
    }
    const attrs: Record<string, JsonValue> = {};
    const bag = callerContext['attributes'];
    if (bag !== null && typeof bag === 'object' && !Array.isArray(bag)) {
      Object.assign(attrs, bag);
    }
    for (const [k, v] of Object.entries(callerContext)) {
      if (k === 'targetingKey' || k === 'attributes') continue;
      attrs[k] = v;
    }
    if (Object.keys(attrs).length > 0) snapshot['attributes'] = attrs;
    output['contextSnapshotAfter'] = snapshot;
  }
  if (fixture.expect['resolvedContext'] !== undefined) {
    output['resolvedContext'] = resolvedContextView(runtime.resolveContext(invocationContext)) as unknown as JsonValue;
  }
  if (fixture.expect['networkCalls'] !== undefined) {
    output['networkCalls'] = count();
  }
  return output;
}

async function runLifecycleOpFixture(fixture: Fixture): Promise<ActualOutput> {
  const given = fixture.given;
  const when = fixture.when;
  const operation = when.operation;

  if (operation === 'replaceProvider') {
    const domain = uniqueDomain(fixture.id);
    const runtimeA = new FireweaveRuntime(new InMemoryAdapter({ flags: given.flags ?? {} }));
    await runtimeA.initialize();
    await OpenFeature.setProviderAndWait(domain, new FireweaveProvider(runtimeA));

    const runtimeB = new FireweaveRuntime(new InMemoryAdapter({ flags: given.replacement?.flags ?? {} }));
    await runtimeB.initialize();
    await OpenFeature.setProviderAndWait(domain, new FireweaveProvider(runtimeB));

    const thenEvaluate = when['thenEvaluate'] as {
      flagKey: string;
      flagType: string;
      defaultValue: JsonValue;
      invocationContext?: Record<string, JsonValue>;
    };
    const client = OpenFeature.getClient(domain);
    const details = await client.getBooleanDetails(
      thenEvaluate.flagKey,
      thenEvaluate.defaultValue as boolean,
      toOFContext(thenEvaluate.invocationContext),
    );
    return {
      providerState: lifecycleToFixtureState(runtimeB.getState()),
      value: details.value,
      variant: details.variant ?? null,
      reason: details.reason ?? null,
      errorCode: details.errorCode ?? null,
      errorMessage: details.errorMessage ?? null,
    };
  }

  const config = runtimeConfigFrom(given.config);
  const runtime = new FireweaveRuntime(new InMemoryAdapter({ flags: given.flags ?? {} }), config);

  if (operation === 'initialize') {
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    let errorKind: string | null = null;
    try {
      await runtime.initialize();
    } catch (err) {
      if (isFireweaveError(err)) {
        errorCode = err.openFeatureErrorCode;
        errorMessage = err.message;
        errorKind = err.kind;
      } else {
        errorCode = 'GENERAL';
        errorMessage = String(err);
      }
    }
    return {
      providerState: lifecycleToFixtureState(runtime.getState()),
      errorCode,
      errorMessage,
      errorKind,
    };
  }

  if (operation === 'shutdown') {
    await provisionState(runtime, given.providerState);
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    try {
      await runtime.shutdown();
    } catch (err) {
      errorCode = 'GENERAL';
      errorMessage = String(err);
    }
    return {
      providerState: lifecycleToFixtureState(runtime.getState()),
      errorCode,
      errorMessage,
    };
  }

  throw new Error(`unsupported lifecycle operation ${operation}`);
}

async function runExtensionFixture(fixture: Fixture): Promise<ActualOutput> {
  const given = fixture.given;
  const when = fixture.when;
  const adapter = new InMemoryAdapter({ flags: given.flags ?? {} });
  const runtime = new FireweaveRuntime(adapter);
  await provisionState(runtime, given.providerState ?? 'READY');
  const client = new FireweaveClient(runtime);

  if (given.releaseContext !== undefined) {
    client.releases.seed(
      given.releaseContext as unknown as Parameters<typeof client.releases.seed>[0],
      (given.releaseStatus as Parameters<typeof client.releases.seed>[1] | undefined) ?? 'set',
    );
  }
  if (given.exposureQueue !== undefined) {
    client.exposures.seed(given.exposureQueue as unknown as Parameters<typeof client.exposures.seed>[0]);
  }

  const withErrorFields = (result: {
    ok: boolean;
    errorKind?: string;
    errorCode?: string;
    errorMessage?: string;
    degraded?: boolean;
  }): ActualOutput => ({
    ok: result.ok,
    errorCode: result.ok ? null : (result.errorCode ?? null),
    errorMessage: result.ok ? null : (result.errorMessage ?? null),
    errorKind: result.ok ? null : (result.errorKind ?? null),
    ...(result.degraded === true ? { degraded: true } : {}),
  });

  switch (when.operation) {
    case 'getCapabilities': {
      // Ruling 18: the structured static/runtime matrix, never a flat list.
      const matrix = client.capabilities.get();
      const failures: string[] = [];
      if (typeof matrix.static?.language !== 'string') failures.push('static.language missing');
      if (typeof matrix.static?.openFeature?.specFloor !== 'string') failures.push('static.openFeature.specFloor missing');
      if (typeof matrix.runtime?.backend !== 'string') failures.push('runtime.backend missing');
      if (typeof matrix.runtime?.lifecycle !== 'string') failures.push('runtime.lifecycle missing');
      if (failures.length > 0) {
        throw new Error(`capabilities matrix shape invalid: ${failures.join(', ')}`);
      }
      return { capabilities: matrix as unknown as JsonValue, errorCode: null };
    }
    case 'invokeCapability': {
      const result = client.invokeCapability(when['capability'] as string, when['args'] as Record<string, JsonValue>);
      return withErrorFields(result);
    }
    case 'setContext': {
      const result = client.releases.setContext(when['release'] as unknown as Parameters<typeof client.releases.setContext>[0]);
      return { ...withErrorFields(result), releaseContext: result.releaseContext ?? null };
    }
    case 'start':
    case 'complete':
    case 'fail': {
      const args = when['release'] as { rolloutId?: string; reason?: string };
      const result =
        when.operation === 'start'
          ? client.releases.start(args)
          : when.operation === 'complete'
            ? client.releases.complete(args)
            : client.releases.fail(args);
      return {
        ...withErrorFields(result),
        status: result.status ?? null,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
      };
    }
    case 'recordExposure': {
      const result = client.exposures.record(when['exposure'] as unknown as Parameters<typeof client.exposures.record>[0]);
      return {
        ...withErrorFields(result),
        queued: result.queued ?? null,
        ...(result.deduped === true ? { deduped: true } : {}),
      };
    }
    case 'flushExposures': {
      const result = await client.exposures.flush();
      return {
        ...withErrorFields(result),
        flushed: result.flushed ?? null,
        queued: client.exposures.queuedCount(),
      };
    }
    case 'emitSignal': {
      const signal = when['signal'] as unknown as Parameters<typeof client.signals.record>[0];
      const result = client.signals.record(signal);
      const recorded = client.signals.getRecorded();
      const last = recorded[recorded.length - 1];
      return {
        ...withErrorFields(result),
        accepted: result.accepted ?? false,
        recordedMessage: last?.message ?? '',
      };
    }
    default:
      throw new Error(`unsupported extension operation ${when.operation}`);
  }
}

async function runFaultFixture(fixture: Fixture): Promise<ActualOutput> {
  const given = fixture.given;
  const when = fixture.when;
  const fault = given.fault ?? { mode: 'none' };

  // Stale-cache runs on the in-memory adapter (cache state provisioned directly).
  if (fixture.id === 'fault-stale-cache') {
    return runEvaluateFixture(fixture);
  }

  const server = (await startTestServer({ port: 0 })) as {
    url: string;
    close: () => Promise<void>;
    state: { fault: unknown; flagsBody: unknown };
  };
  try {
    // Provision flags body from given.flags in flags-v2 format.
    const flags: Record<string, unknown> = {};
    let flagId = 1;
    for (const [key, def] of Object.entries(given.flags ?? {})) {
      flags[key] = {
        key,
        enabled: def.enabled,
        variant: def.variant !== undefined && def.type !== 'boolean' ? def.variant : null,
        reason: def.reason ?? { code: 'condition_match', condition_index: null, description: 'matched' },
        metadata: { id: def.metadata?.id ?? flagId, version: def.metadata?.version ?? null, payload: null },
      };
      flagId += 1;
    }
    server.state.flagsBody = {
      flags,
      errorsWhileComputingFlags: false,
      requestId: '00000000-0000-4000-8000-00000000f1x7',
      quotaLimited: null,
    };

    // Arm fault. Scope is 'evaluate': faults must hit POST /v1/flags/evaluate,
    // the Fireweave-native route the remote adapter speaks.
    switch (fault.mode) {
      case 'httpStatus':
        server.state.fault = { mode: String(fault.status ?? 500), applyTo: 'evaluate' };
        break;
      case 'invalidJson':
        server.state.fault = { mode: 'invalid_json', body: fault.body ?? '{not-json', applyTo: 'evaluate' };
        break;
      case 'quotaLimited':
        server.state.fault = { mode: 'quota_limited', applyTo: 'evaluate' };
        break;
      case 'delay':
        server.state.fault = { mode: 'delay', delayMs: fault.delayMs ?? 1000, applyTo: 'evaluate' };
        break;
      default:
        break;
    }

    const offline = fault.mode === 'networkError' || fault.mode === 'offline';
    const host = server.url;
    if (offline) {
      await server.close(); // dead port ⇒ transport error
    }

    const timeoutMs = (given.config?.['featureFlagsRequestTimeoutMs'] as number | undefined) ?? 3000;
    // The fixture's key is passed through verbatim rather than replaced with a
    // Fireweave-shaped one: sec-secrets-not-in-errors asserts that no `phc_`
    // substring reaches an error message, and substituting the key would make
    // that assertion pass trivially instead of exercising redaction.
    const projectApiKey = (given.config?.['projectApiKey'] as string | undefined) ?? 'phc_TESTKEY0000000000000000000001';
    const adapter = new FireweaveRemoteAdapter({
      apiUrl: host,
      apiKey: projectApiKey,
      requestTimeoutMs: timeoutMs,
    });
    const runtime = new FireweaveRuntime(adapter, { projectApiKey, host });
    await runtime.initialize();
    const provider = new FireweaveProvider(runtime);
    const output = await evaluateThroughOpenFeature(uniqueDomain(fixture.id), provider, {
      flagKey: when['flagKey'] as string,
      flagType: when['flagType'] as string,
      defaultValue: when['defaultValue'] as JsonValue,
      context: toOFContext(when['invocationContext'] as Record<string, JsonValue> | undefined),
    });
    await runtime.shutdown();
    return output;
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// main

/** Run one fully-resolved when/expect pair; returns comparator failures. */
async function executeOne(fixture: Fixture): Promise<string[]> {
  let actual: ActualOutput;
  if (fixture.suite === 'faults') {
    actual = await runFaultFixture(fixture);
  } else if (fixture.when.operation === 'evaluate') {
    actual = await runEvaluateFixture(fixture);
  } else if (
    fixture.when.operation === 'initialize' ||
    fixture.when.operation === 'shutdown' ||
    fixture.when.operation === 'replaceProvider'
  ) {
    actual = await runLifecycleOpFixture(fixture);
  } else {
    actual = await runExtensionFixture(fixture);
  }
  // getCapabilities exception (harness.md): expect.capabilities compares as a
  // subset of the structured matrix; all other keys stay strict.
  const subsetKeys = fixture.when.operation === 'getCapabilities' ? ['capabilities'] : [];
  return diff(fixture.expect, actual, subsetKeys);
}

async function main(): Promise<void> {
  const fixtures = loadFixtures();
  const rows: ReportRow[] = [];

  for (const fixture of fixtures) {
    const declared = fixture.compatibility['node'];
    if (declared === 'skipped-with-documented-limitation') {
      rows.push({
        fixtureId: fixture.id,
        suite: fixture.suite,
        language: 'node',
        status: 'skipped-with-documented-limitation',
        limitation: fixture.limitations['node'] ?? 'documented limitation',
        message: null,
      });
      continue;
    }

    // Multi-case fixtures run every case against a fresh setup; the fixture
    // passes only when all cases pass (one report row per fixture).
    const runs: Array<{ label: string | null; fixture: Fixture }> =
      fixture.cases !== undefined
        ? fixture.cases.map((c) => ({
            label: c.name,
            fixture: {
              ...fixture,
              given: { ...fixture.given, ...(c.given ?? {}) },
              when: c.when,
              expect: c.expect,
            },
          }))
        : [{ label: null, fixture }];

    let status: ReportRow['status'] = 'pass';
    const messages: string[] = [];
    for (const run of runs) {
      const prefix = run.label !== null ? `[${run.label}] ` : '';
      try {
        const failures = await executeOne(run.fixture);
        if (failures.length > 0) {
          status = 'fail';
          messages.push(`${prefix}${failures.join('; ')}`);
        }
      } catch (err) {
        status = 'fail';
        messages.push(`${prefix}harness error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const message = messages.length > 0 ? messages.join(' | ') : null;
    rows.push({ fixtureId: fixture.id, suite: fixture.suite, language: 'node', status, limitation: null, message });
  }

  const summary = {
    pass: rows.filter((r) => r.status === 'pass').length,
    fail: rows.filter((r) => r.status === 'fail').length,
    'skipped-with-documented-limitation': rows.filter((r) => r.status === 'skipped-with-documented-limitation').length,
  };
  const report = {
    schemaVersion: 1,
    generatedAt: 'EXCLUDED',
    sdkCommit: 'workspace',
    contractsCommit: 'workspace',
    results: rows,
    summary,
  };
  const reportPath = join(HERE, 'compatibility-report.node.json');
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  for (const row of rows) {
    const mark = row.status === 'pass' ? 'PASS' : row.status === 'fail' ? 'FAIL' : 'SKIP';
    console.log(`${mark}  ${row.fixtureId}${row.message !== null ? `  — ${row.message}` : ''}`);
  }
  console.log(
    `\n${summary.pass} passed, ${summary.fail} failed, ${summary['skipped-with-documented-limitation']} skipped-with-documented-limitation (report: ${reportPath})`,
  );

  await OpenFeature.close();
  process.exit(summary.fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
