/**
 * Fireweave Node conformance runner (contracts/harness.md).
 *
 * Loads all contracts/{evaluation,context,lifecycle,faults,security,extensions}
 * fixtures, provisions `given`, invokes `when` through the real v1 control-point
 * surface (`FireweaveClient.controlPoints`, NOT OpenFeature — the OpenFeature
 * provider was retired by ADR-0010; see contracts/harness.md "Shared pipeline"),
 * normalizes actual output, diffs against `expect`, and writes
 * compatibility-report.node.json. Exits non-zero on any fail.
 *
 * Backends:
 *  - evaluation/context/lifecycle/security → InMemoryAdapter from given.flags,
 *    driving FireweaveRuntime + FireweaveClient directly (the raw construction
 *    path, same as conformance/surface/'s own surface test — NOT
 *    `initFireweave({mode:'local'})`: that entry point's local adapter
 *    (FireweaveLocalAdapter) only accepts a `Record<string, boolean>` override
 *    map with no variant/metadata/condition support, so it cannot carry the
 *    rich InMemoryFlagDefinition fixtures rely on. `initFireweave` itself is
 *    exercised end-to-end by test/unit/init-fireweave.test.ts, part of
 *    `npm run verify` via `npm run test`).
 *  - faults (HTTP semantics) → FireweaveRemoteAdapter against the test-server's
 *    Fireweave-native route (POST /v1/flags/evaluate), fault scope 'evaluate'
 *    (fault-stale-cache runs on the InMemoryAdapter instead: cache staleness
 *    is provisioned directly per given.flags.fromCache + providerState
 *    STALE). Constructed directly (FireweaveRemoteAdapter + FireweaveRuntime),
 *    not via `initFireweave({mode:'remote'})`: fault-timeout needs a
 *    fixture-supplied `requestTimeoutMs`, a knob `initFireweave`'s remote
 *    options do not expose. This is still the pipeline's "remote mode ...
 *    exercising the remote adapter" leg — real HTTP against test-server;
 *    `initFireweave` itself (both modes) is unit-tested end-to-end by
 *    test/unit/init-fireweave.test.ts, part of `npm run verify` via
 *    `npm run test`.
 *  - extensions → 13 of 14 fixtures target namespaces cut from the v1 surface
 *    (releases/exposures/signals/capabilities — see the classification table
 *    below and contracts/harness.md "v1-scope rule"); those are reported
 *    `skipped-v1-out-of-scope`, never executed. Only
 *    ext-unsupported-capability-degrade exercises real v1 surface
 *    (`FireweaveClient.invokeCapability`) and runs for real.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FireweaveClient,
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

type ReportStatus = 'pass' | 'fail' | 'skipped-with-documented-limitation' | 'skipped-v1-out-of-scope';

interface ReportRow {
  fixtureId: string;
  suite: string;
  language: 'node';
  status: ReportStatus;
  limitation: string | null;
  message: string | null;
}

type ActualOutput = Record<string, unknown>;

// ---------------------------------------------------------------------------
// v1-scope classification (contracts/harness.md "Extension fixtures — v1
// scope rule", ruling 2). contracts/extensions/*.json are frozen (byte-for-
// byte, per the plan's header) and were authored against the pre-v1 surface
// (releases/exposures/signals/capabilities discovery) — cut entirely by
// ADR-0010. Each of the 14 fixtures was read before classifying:
//
//  - 13 fixtures dispatch `when.operation` (every `cases[].when.operation`
//    for ext-lifecycle-gating) onto a cut namespace and are reported
//    `skipped-v1-out-of-scope`, never executed:
//      ext-capabilities-get            -> getCapabilities   (capabilities)
//      ext-exposures-dedup             -> recordExposure    (exposures)
//      ext-exposures-flush             -> flushExposures    (exposures)
//      ext-exposures-record            -> recordExposure    (exposures)
//      ext-lifecycle-gating            -> emitSignal x3     (signals)
//      ext-releases-complete           -> complete          (releases)
//      ext-releases-fail               -> fail              (releases)
//      ext-releases-set-context        -> setContext        (releases)
//      ext-releases-start              -> start             (releases)
//      ext-signals-error               -> emitSignal        (signals)
//      ext-signals-health              -> emitSignal        (signals)
//      ext-signals-metric              -> emitSignal        (signals)
//      ext-signals-outcome             -> emitSignal        (signals)
//
//    ext-lifecycle-gating reads, on its surface, like the invokeCapability
//    lifecycle-gate exception this rule carves out (its description cites
//    "ruling 17", the same rule client.ts's `lifecycleGate` docstring names)
//    — but its three cases all dispatch `emitSignal`, and its middle case
//    ("ready-delivered-to-sink") expects `ok:true`/`accepted:true`, an
//    outcome `invokeCapability` can never produce: v1's
//    `SUPPORTED_CAPABILITIES` is frozen empty (client.ts), so
//    `invokeCapability` degrades UnsupportedCapability in EVERY lifecycle
//    state, including READY. Reproducing this fixture for real would require
//    the cut `signals` namespace, so it is classified with its siblings, not
//    as the exception.
//
//  - 1 fixture genuinely exercises v1 surface and runs for real:
//      ext-unsupported-capability-degrade -> invokeCapability (present on
//        FireweaveClient in v1 — NOT on the mustNotExpose list; its expected
//        {ok:false, errorKind:UnsupportedCapability, degraded:true} is
//        exactly what invokeCapability produces for any capability string,
//        because SUPPORTED_CAPABILITIES is empty).
const V1_OUT_OF_SCOPE_EXTENSION_FIXTURES = new Set([
  'ext-capabilities-get',
  'ext-exposures-dedup',
  'ext-exposures-flush',
  'ext-exposures-record',
  'ext-lifecycle-gating',
  'ext-releases-complete',
  'ext-releases-fail',
  'ext-releases-set-context',
  'ext-releases-start',
  'ext-signals-error',
  'ext-signals-health',
  'ext-signals-metric',
  'ext-signals-outcome',
]);

const v1OutOfScopeNamespace = (fixtureId: string): string => {
  if (fixtureId === 'ext-capabilities-get') return 'capabilities';
  if (fixtureId.startsWith('ext-exposures-')) return 'exposures';
  if (fixtureId === 'ext-lifecycle-gating') return 'signals';
  if (fixtureId.startsWith('ext-releases-')) return 'releases';
  if (fixtureId.startsWith('ext-signals-')) return 'signals';
  return 'unknown';
};

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
 * Fixture context → Fireweave context. The canonical {targetingKey, attributes}
 * bag shape is passed through untouched: the SDK understands it natively, and
 * flattening would let attributes.targetingKey collide with the real targeting
 * key (ctx-reserved-keys-rejected).
 */
function toContext(ctx: Record<string, JsonValue> | undefined): Record<string, JsonValue> {
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

const toExpectedType = (flagType: string): 'boolean' | 'string' | 'number' | 'object' => {
  if (flagType === 'integer' || flagType === 'float') return 'number';
  return flagType as 'boolean' | 'string' | 'object';
};

/**
 * Invoke a control point through the real v1 client surface
 * (`FireweaveClient.controlPoints.evaluate` — the general form the
 * `get<Type>Details` sugar methods delegate to; used directly here rather
 * than the sugar so `when.options` — currently only `includePayload`,
 * exercised by eval-payload-attached — has somewhere to go, since the sugar
 * methods only take `(key, default, context?)`, no options) and map the
 * returned {@link Decision} back onto the fixture's wire shape
 * (`flagMetadata`, not `metadata` — the fixture-facing name predates the
 * Decision type's own field rename and stays fixed here rather than in the
 * SDK).
 */
async function evaluateThroughClient(
  client: FireweaveClient,
  when: {
    flagKey: string;
    flagType: string;
    defaultValue: JsonValue;
    context: Record<string, JsonValue>;
    options?: { includePayload?: boolean };
  },
): Promise<ActualOutput> {
  const decision: Decision = await client.controlPoints.evaluate(
    when.flagKey,
    toExpectedType(when.flagType),
    when.defaultValue,
    when.context,
    when.options,
  );
  return {
    value: decision.value,
    variant: decision.variant ?? null,
    reason: decision.reason ?? null,
    errorCode: decision.errorCode ?? null,
    errorMessage: decision.errorMessage ?? null,
    flagMetadata: decision.metadata ?? {},
  };
}

// ---------------------------------------------------------------------------
// per-suite executors

async function runEvaluateFixture(fixture: Fixture): Promise<ActualOutput> {
  const given = fixture.given;
  const when = fixture.when;

  // Multi-domain lifecycle fixture support: two independent runtimes/clients
  // (no OpenFeature domain multiplexing to reach for post-ADR-0010 — each
  // "domain" is just its own FireweaveClient).
  if (given.domains !== undefined) {
    const requestedDomain = when['domain'] as string;
    let output: ActualOutput = {};
    for (const [domainName, domainGiven] of Object.entries(given.domains)) {
      const adapter = new InMemoryAdapter({ flags: domainGiven.flags ?? {} });
      const runtime = new FireweaveRuntime(adapter);
      await provisionState(runtime, domainGiven.providerState);
      const client = new FireweaveClient(runtime);
      if (domainName === requestedDomain) {
        output = await evaluateThroughClient(client, {
          flagKey: when['flagKey'] as string,
          flagType: when['flagType'] as string,
          defaultValue: when['defaultValue'] as JsonValue,
          context: toContext(when['invocationContext'] as Record<string, JsonValue> | undefined),
        });
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

  const client = new FireweaveClient(runtime);
  const invocationContext = when['invocationContext'] as Record<string, JsonValue> | undefined;
  const callerContext = toContext(invocationContext);
  const options = when['options'] as { includePayload?: boolean } | undefined;
  const output = await evaluateThroughClient(client, {
    flagKey: when['flagKey'] as string,
    flagType: when['flagType'] as string,
    defaultValue: when['defaultValue'] as JsonValue,
    context: callerContext,
    ...(options !== undefined ? { options } : {}),
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
    const runtimeA = new FireweaveRuntime(new InMemoryAdapter({ flags: given.flags ?? {} }));
    await runtimeA.initialize();
    await runtimeA.shutdown(); // old provider retired before the replacement takes over

    const runtimeB = new FireweaveRuntime(new InMemoryAdapter({ flags: given.replacement?.flags ?? {} }));
    await runtimeB.initialize();
    const client = new FireweaveClient(runtimeB);

    const thenEvaluate = when['thenEvaluate'] as {
      flagKey: string;
      flagType: string;
      defaultValue: JsonValue;
      invocationContext?: Record<string, JsonValue>;
    };
    const decision = await evaluateThroughClient(client, {
      flagKey: thenEvaluate.flagKey,
      flagType: thenEvaluate.flagType,
      defaultValue: thenEvaluate.defaultValue,
      context: toContext(thenEvaluate.invocationContext),
    });
    return {
      providerState: lifecycleToFixtureState(runtimeB.getState()),
      value: decision['value'],
      variant: decision['variant'],
      reason: decision['reason'],
      errorCode: decision['errorCode'],
      errorMessage: decision['errorMessage'],
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

/**
 * Only `ext-unsupported-capability-degrade` reaches this function (the one
 * extensions fixture classified as v1-runnable — see
 * V1_OUT_OF_SCOPE_EXTENSION_FIXTURES above). It exercises
 * `FireweaveClient.invokeCapability`, present and un-cut in v1.
 */
async function runExtensionFixture(fixture: Fixture): Promise<ActualOutput> {
  const given = fixture.given;
  const when = fixture.when;
  const adapter = new InMemoryAdapter({ flags: given.flags ?? {} });
  const runtime = new FireweaveRuntime(adapter);
  await provisionState(runtime, given.providerState ?? 'READY');
  const client = new FireweaveClient(runtime);

  if (when.operation !== 'invokeCapability') {
    throw new Error(`unsupported v1 extension operation ${when.operation} (should have been classified skipped-v1-out-of-scope)`);
  }
  const result = client.invokeCapability(when['capability'] as string, when['args'] as Record<string, JsonValue>);
  return {
    ok: result.ok,
    errorCode: result.ok ? null : (result.errorCode ?? null),
    errorMessage: result.ok ? null : (result.errorMessage ?? null),
    errorKind: result.ok ? null : (result.errorKind ?? null),
    ...(result.degraded === true ? { degraded: true } : {}),
  };
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
    const client = new FireweaveClient(runtime);
    const output = await evaluateThroughClient(client, {
      flagKey: when['flagKey'] as string,
      flagType: when['flagType'] as string,
      defaultValue: when['defaultValue'] as JsonValue,
      context: toContext(when['invocationContext'] as Record<string, JsonValue> | undefined),
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
  const subsetKeys: string[] = [];
  return diff(fixture.expect, actual, subsetKeys);
}

async function main(): Promise<void> {
  const fixtures = loadFixtures();
  const rows: ReportRow[] = [];

  for (const fixture of fixtures) {
    // v1-scope rule (contracts/harness.md): extensions fixtures that target a
    // cut namespace are reported skipped-v1-out-of-scope and never executed,
    // regardless of the fixture's own declared compatibility (frozen "pass",
    // authored pre-cut). See V1_OUT_OF_SCOPE_EXTENSION_FIXTURES above.
    if (fixture.suite === 'extensions' && V1_OUT_OF_SCOPE_EXTENSION_FIXTURES.has(fixture.id)) {
      rows.push({
        fixtureId: fixture.id,
        suite: fixture.suite,
        language: 'node',
        status: 'skipped-v1-out-of-scope',
        limitation: `targets the ${v1OutOfScopeNamespace(fixture.id)} namespace, cut from the v1 control-points surface (ADR-0010)`,
        message: null,
      });
      continue;
    }

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
    'skipped-v1-out-of-scope': rows.filter((r) => r.status === 'skipped-v1-out-of-scope').length,
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
    `\n${summary.pass} passed, ${summary.fail} failed, ` +
      `${summary['skipped-with-documented-limitation']} skipped-with-documented-limitation, ` +
      `${summary['skipped-v1-out-of-scope']} skipped-v1-out-of-scope ` +
      `(report: ${reportPath})`,
  );

  process.exit(summary.fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
