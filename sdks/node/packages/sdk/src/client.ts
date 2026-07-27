/**
 * FireweaveClient — release-safety extensions beyond OpenFeature
 * (docs/architecture.md §6): releases, exposures, signals, guardrails (stub),
 * capabilities. Facade methods degrade instead of throwing.
 */
import { FireweaveError, redactSecrets, type FireweaveErrorKind } from './errors.js';
import { DEFAULT_SHUTDOWN_TIMEOUT_MS, stableStringify } from './runtime.js';
import type { EvaluateOptions, ExpectedFlagType, FireweaveRuntime } from './runtime.js';
import type { ContextInput } from './context.js';
import type {
  Capabilities,
  Decision,
  Exposure,
  JsonValue,
  ReleaseContext,
  ReleaseState,
  ReleaseStatus,
  Signal,
  SignalKind,
} from './types.js';

const SDK_VERSION = '0.1.0';

export interface ExtensionResult {
  ok: boolean;
  errorKind?: FireweaveErrorKind;
  errorCode?: string;
  errorMessage?: string;
  degraded?: boolean;
}

export interface ReleaseResult extends ExtensionResult {
  status?: ReleaseStatus;
  reason?: string;
  releaseContext?: ReleaseContext;
}

export interface ExposureResult extends ExtensionResult {
  queued?: number;
  flushed?: number;
  deduped?: boolean;
}

export interface SignalResult extends ExtensionResult {
  accepted?: boolean;
}

/**
 * Canonical telemetry attribute allowlist (M-3; matches Python/Go): applied
 * by default so arbitrary PII cannot ride along on signal attributes.
 */
export const DEFAULT_SIGNAL_ATTRIBUTE_ALLOWLIST: readonly string[] = Object.freeze([
  'name',
  'kind',
  'status',
  'value',
  'unit',
  'rolloutId',
  'changeId',
  'stampId',
  'errorKind',
  'message',
  'flagKey',
  'variant',
  'environment',
  'service',
]);

/** Attribute allowlist applied to signal attributes before recording. */
export interface TelemetryPolicy {
  /**
   * Attribute keys allowed on signals/exposures.
   * Undefined ⇒ DEFAULT_SIGNAL_ATTRIBUTE_ALLOWLIST (allowlist is ON by default).
   */
  attributeAllowlist?: readonly string[];
}

const failure = (err: FireweaveError, degraded = false): ExtensionResult => ({
  ok: false,
  errorKind: err.kind,
  errorCode: err.openFeatureErrorCode,
  errorMessage: err.message,
  ...(degraded ? { degraded: true } : {}),
});

/**
 * Lifecycle gate for extension calls (ruling 17, Go/Java model; fixture
 * ext-lifecycle-gating): READY/STALE proceed; post-shutdown degrades
 * AlreadyClosed; pre-ready degrades UnsupportedCapability. Gated methods never
 * throw — failures come back as structured, degraded results.
 */
const lifecycleGate = (runtime: FireweaveRuntime): FireweaveError | undefined => {
  switch (runtime.getState()) {
    case 'READY':
    case 'STALE':
      return undefined;
    case 'SHUTDOWN':
      return new FireweaveError('AlreadyClosed');
    default:
      return new FireweaveError('UnsupportedCapability');
  }
};

class ReleasesApi {
  private state: ReleaseState | undefined;
  private readonly runtime: FireweaveRuntime;
  private readonly signals: SignalsApi;

  constructor(runtime: FireweaveRuntime, signals: SignalsApi) {
    this.runtime = runtime;
    this.signals = signals;
  }

  setContext(context: ReleaseContext): ReleaseResult {
    const gateError = lifecycleGate(this.runtime);
    if (gateError !== undefined) return failure(gateError, true);
    // Ruling 15: exactly the spec's required set — rolloutId + stampIds.
    if (typeof context.rolloutId !== 'string' || context.rolloutId.length === 0) {
      return failure(new FireweaveError('InvalidContext', { message: 'release context requires rolloutId' }));
    }
    if (!Array.isArray(context.stampIds) || context.stampIds.length === 0) {
      return failure(new FireweaveError('InvalidContext', { message: 'release context requires stampIds' }));
    }
    const copy: ReleaseContext = JSON.parse(JSON.stringify(context)) as ReleaseContext;
    this.state = { context: copy, status: 'set' };
    return { ok: true, releaseContext: copy };
  }

  /** Test/fixture hook: seed a release already in progress. */
  seed(context: ReleaseContext, status: ReleaseStatus): void {
    this.state = { context: JSON.parse(JSON.stringify(context)) as ReleaseContext, status };
  }

  getState(): ReleaseState | undefined {
    return this.state;
  }

  private requireRelease(rolloutId?: string): ReleaseState | FireweaveError {
    if (this.state === undefined) {
      return new FireweaveError('InvalidContext', { message: 'no release context set' });
    }
    if (rolloutId !== undefined && this.state.context.rolloutId !== rolloutId) {
      return new FireweaveError('InvalidContext', { message: 'unknown rollout id' });
    }
    return this.state;
  }

  start(args: { rolloutId?: string } = {}): ReleaseResult {
    const gateError = lifecycleGate(this.runtime);
    if (gateError !== undefined) return failure(gateError, true);
    const state = this.requireRelease(args.rolloutId);
    if (state instanceof FireweaveError) return failure(state);
    state.status = 'in_progress';
    return { ok: true, status: 'in_progress' };
  }

  complete(args: { rolloutId?: string } = {}): ReleaseResult {
    const gateError = lifecycleGate(this.runtime);
    if (gateError !== undefined) return failure(gateError, true);
    const state = this.requireRelease(args.rolloutId);
    if (state instanceof FireweaveError) return failure(state);
    state.status = 'completed';
    this.signals.record({
      kind: 'outcome',
      name: 'release',
      status: 'completed',
      ...(state.context.rolloutId !== undefined ? { rolloutId: state.context.rolloutId } : {}),
    });
    return { ok: true, status: 'completed' };
  }

  fail(args: { rolloutId?: string; reason?: string } = {}): ReleaseResult {
    const gateError = lifecycleGate(this.runtime);
    if (gateError !== undefined) return failure(gateError, true);
    const state = this.requireRelease(args.rolloutId);
    if (state instanceof FireweaveError) return failure(state);
    state.status = 'failed';
    const reason = args.reason !== undefined ? redactSecrets(args.reason) : undefined;
    if (reason !== undefined) state.reason = reason;
    this.signals.record({
      kind: 'outcome',
      name: 'release',
      status: 'failed',
      ...(state.context.rolloutId !== undefined ? { rolloutId: state.context.rolloutId } : {}),
    });
    return { ok: true, status: 'failed', ...(reason !== undefined ? { reason } : {}) };
  }
}

class ExposuresApi {
  private readonly runtime: FireweaveRuntime;
  private queue: Exposure[] = [];
  private readonly seen = new Set<string>();
  private flushedTotal = 0;

  constructor(runtime: FireweaveRuntime) {
    this.runtime = runtime;
  }

  private dedupKey(e: Exposure): string {
    return `${e.targetingKey}\u0000${e.flagKey}\u0000${e.variant ?? ''}\u0000${stableStringify(e.value ?? null)}`;
  }

  record(exposure: Exposure): ExposureResult {
    const gateError = lifecycleGate(this.runtime);
    if (gateError !== undefined) return failure(gateError, true);
    if (typeof exposure.targetingKey !== 'string' || exposure.targetingKey.length === 0 ||
        typeof exposure.flagKey !== 'string' || exposure.flagKey.length === 0) {
      return failure(new FireweaveError('InvalidContext', { message: 'exposure requires targetingKey and flagKey' }));
    }
    const key = this.dedupKey(exposure);
    if (this.seen.has(key)) {
      return { ok: true, queued: this.queue.length, deduped: true };
    }
    this.seen.add(key);
    this.queue.push({ ...exposure });
    return { ok: true, queued: this.queue.length };
  }

  /** Test/fixture hook: pre-populate the queue (marks entries seen for dedup). */
  seed(exposures: Exposure[]): void {
    for (const e of exposures) {
      this.seen.add(this.dedupKey(e));
      this.queue.push({ ...e });
    }
  }

  queuedCount(): number {
    return this.queue.length;
  }

  async flush(signal?: AbortSignal): Promise<ExposureResult> {
    const gateError = lifecycleGate(this.runtime);
    if (gateError !== undefined) return failure(gateError, true);
    if (signal?.aborted) {
      return failure(new FireweaveError('Timeout', { message: 'flush aborted' }));
    }
    const draining = this.queue;
    this.queue = [];
    // Ratified dedup lifecycle (M-2, Python's model): the dedup window is one
    // flush cycle, so the seen-set cannot grow without bound.
    this.seen.clear();
    for (const exposure of draining) {
      this.runtime.adapter.recordExposure?.(exposure);
    }
    try {
      await this.runtime.adapter.flush?.();
    } catch (err) {
      const fw = err instanceof FireweaveError ? err : new FireweaveError('Network', { cause: err });
      return failure(fw);
    }
    this.flushedTotal += draining.length;
    return { ok: true, flushed: draining.length, queued: this.queue.length };
  }
}

class SignalsApi {
  private readonly recorded: Signal[] = [];
  private readonly runtime: FireweaveRuntime;
  private readonly attributeAllowlist: readonly string[];

  constructor(runtime: FireweaveRuntime, policy: TelemetryPolicy = {}) {
    this.runtime = runtime;
    // Allowlist is ON by default (M-3): callers may extend/override explicitly.
    this.attributeAllowlist = policy.attributeAllowlist ?? DEFAULT_SIGNAL_ATTRIBUTE_ALLOWLIST;
  }

  record(signal: Signal): SignalResult {
    const gateError = lifecycleGate(this.runtime);
    if (gateError !== undefined) return failure(gateError, true);
    if (typeof signal.name !== 'string' || signal.name.length === 0) {
      return failure(new FireweaveError('InvalidContext', { message: 'signal name must be non-empty' }));
    }
    const clean: Signal = { ...signal };
    if (clean.message !== undefined) clean.message = redactSecrets(clean.message);
    if (clean.attributes !== undefined) {
      const attrs: Record<string, string | number | boolean | null> = {};
      for (const [k, v] of Object.entries(clean.attributes)) {
        if (!this.attributeAllowlist.includes(k)) continue;
        attrs[k] = typeof v === 'string' ? redactSecrets(v) : v;
      }
      clean.attributes = attrs;
    }
    this.recorded.push(clean);
    // Ruling 17: signals are delivered to the adapter sink when it has one.
    this.runtime.adapter.recordSignal?.(clean);
    return { ok: true, accepted: true };
  }

  recordHealth(signal: Omit<Signal, 'kind'>): SignalResult {
    return this.record({ ...signal, kind: 'health' });
  }

  recordError(signal: Omit<Signal, 'kind'>): SignalResult {
    return this.record({ ...signal, kind: 'error' });
  }

  recordMetric(signal: Omit<Signal, 'kind'>): SignalResult {
    return this.record({ ...signal, kind: 'metric' });
  }

  recordOutcome(signal: Omit<Signal, 'kind'>): SignalResult {
    return this.record({ ...signal, kind: 'outcome' });
  }

  getRecorded(kind?: SignalKind): readonly Signal[] {
    return kind === undefined ? this.recorded : this.recorded.filter((s) => s.kind === kind);
  }
}

/**
 * Detailed evaluation on the public client surface (ruling 16): Decision-returning
 * evaluation without reaching into the runtime. Never throws — errors surface
 * as ERROR decisions, exactly like the OpenFeature path.
 */
class FlagsApi {
  private readonly runtime: FireweaveRuntime;

  constructor(runtime: FireweaveRuntime) {
    this.runtime = runtime;
  }

  /** Evaluate a flag to a canonical Decision (detailed evaluation). */
  evaluate(
    flagKey: string,
    expectedType: ExpectedFlagType,
    defaultValue: JsonValue,
    context?: ContextInput,
    options?: EvaluateOptions,
  ): Promise<Decision> {
    return this.runtime.evaluate(flagKey, expectedType, defaultValue, context, options ?? {});
  }

  async getBooleanValue(flagKey: string, defaultValue: boolean, context?: ContextInput): Promise<boolean> {
    const decision = await this.evaluate(flagKey, 'boolean', defaultValue, context);
    return decision.value as boolean;
  }

  async getStringValue(flagKey: string, defaultValue: string, context?: ContextInput): Promise<string> {
    const decision = await this.evaluate(flagKey, 'string', defaultValue, context);
    return decision.value as string;
  }

  async getNumberValue(flagKey: string, defaultValue: number, context?: ContextInput): Promise<number> {
    const decision = await this.evaluate(flagKey, 'number', defaultValue, context);
    return decision.value as number;
  }

  async getObjectValue(flagKey: string, defaultValue: JsonValue, context?: ContextInput): Promise<JsonValue> {
    const decision = await this.evaluate(flagKey, 'object', defaultValue, context);
    return decision.value;
  }
}

/** Phase-one guardrails stub: every method degrades with UnsupportedCapability. */
class GuardrailsApi {
  evaluate(_name: string, _args?: Record<string, JsonValue>): ExtensionResult {
    return failure(new FireweaveError('UnsupportedCapability'), true);
  }
}

const SUPPORTED_CAPABILITIES: readonly string[] = Object.freeze([
  'releases.setContext',
  'releases.start',
  'releases.complete',
  'releases.fail',
  'exposures.record',
  'exposures.flush',
  'signals.recordHealth',
  'signals.recordError',
  'signals.recordMetric',
  'signals.recordOutcome',
  'capabilities.get',
]);

class CapabilitiesApi {
  private readonly runtime: FireweaveRuntime;

  constructor(runtime: FireweaveRuntime) {
    this.runtime = runtime;
  }

  /** Operation names supported by this build (conformance shape). */
  list(): readonly string[] {
    return SUPPORTED_CAPABILITIES;
  }

  /** Full capability matrix (spec/capabilities.schema.json). */
  get(): Capabilities {
    const adapterFeatures = this.runtime.adapter.features();
    return {
      static: {
        language: 'node',
        sdkVersion: SDK_VERSION,
        specVersion: '0.1.0',
        openFeature: { specFloor: '0.8.0', providerName: 'fireweave', serverOnly: true },
        features: {
          flags: true,
          releases: true,
          exposures: true,
          signals: true,
          guardrails: false,
          telemetryOptIn: true,
          inMemoryAdapter: true,
          posthogAdapter: true,
        },
      },
      runtime: {
        backend: this.runtime.adapter.name === 'other' ? 'other' : this.runtime.adapter.name,
        lifecycle: this.runtime.getState(),
        features: {
          remoteEvaluation: adapterFeatures.remoteEvaluation ?? false,
          localEvaluation: adapterFeatures.localEvaluation ?? false,
          localOnly: adapterFeatures.localOnly ?? false,
          exposureEmission: adapterFeatures.exposureEmission ?? false,
          sideEffectFreeReads: adapterFeatures.sideEffectFreeReads ?? false,
          groupAnalytics: adapterFeatures.groupAnalytics ?? false,
        },
        limits: {
          intSafeMaxAbs: 9007199254740991,
          // Effective configured shutdown bound (single source of truth, L-4).
          shutdownTimeoutMsDefault: this.runtime.config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
        },
      },
    };
  }
}

export interface FireweaveClientOptions {
  telemetry?: TelemetryPolicy;
}

export class FireweaveClient {
  readonly runtime: FireweaveRuntime;
  readonly flags: FlagsApi;
  readonly releases: ReleasesApi;
  readonly exposures: ExposuresApi;
  readonly signals: SignalsApi;
  readonly guardrails: GuardrailsApi;
  readonly capabilities: CapabilitiesApi;

  constructor(runtime: FireweaveRuntime, options: FireweaveClientOptions = {}) {
    this.runtime = runtime;
    this.flags = new FlagsApi(runtime);
    this.signals = new SignalsApi(runtime, options.telemetry ?? {});
    this.releases = new ReleasesApi(runtime, this.signals);
    this.exposures = new ExposuresApi(runtime);
    this.guardrails = new GuardrailsApi();
    this.capabilities = new CapabilitiesApi(runtime);
  }

  /**
   * Dynamic capability dispatch. Unknown capabilities degrade with
   * UnsupportedCapability — never throws (fixture ext-unsupported-capability-degrade).
   * Known capabilities are lifecycle-gated like the namespaced APIs (ruling 17).
   */
  invokeCapability(capability: string, _args?: Record<string, JsonValue>): ExtensionResult {
    if (!SUPPORTED_CAPABILITIES.includes(capability)) {
      return failure(new FireweaveError('UnsupportedCapability'), true);
    }
    if (capability !== 'capabilities.get') {
      const gateError = lifecycleGate(this.runtime);
      if (gateError !== undefined) return failure(gateError, true);
    }
    return { ok: true };
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    await this.runtime.initialize(signal);
  }

  async shutdown(): Promise<void> {
    await this.exposures.flush();
    await this.runtime.shutdown();
  }
}
