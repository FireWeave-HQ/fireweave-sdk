/**
 * FireweaveWebRuntime — the async/sync boundary.
 *
 * `initialize()` and `setContext()` prefetch a decision cache asynchronously;
 * `evaluateSync()` is a pure read of that cache. That split is what lets a
 * synchronous OpenFeature web provider sit on top of an architecture that is
 * otherwise async, without either side bending.
 *
 * ## Fail-open, not fail-silent
 *
 * A hung backend must not block app boot, so the prefetch races a ceiling. What
 * happens when the ceiling wins is the design decision that matters: this
 * runtime enters `STALE` — not `READY` — and serves defaults with reason
 * `STALE`, so a timed-out boot is DISTINGUISHABLE from a successful one.
 *
 * The tempting alternative (resolve the race and carry on) makes a failed
 * prefetch look exactly like a successful one where every control point
 * happened to be off. Under a progressive rollout that is the difference
 * between "nobody got the feature because the ramp is at 0%" and "nobody got
 * the feature because the SDK never reached the server", and no operator can
 * tell those apart after the fact.
 */
import { FireweaveError, isFireweaveError } from './errors.js';
import { canonicalizeContext, DEFAULT_CONTEXT_LIMITS, mergeContexts } from './context.js';
import type { ContextInput, ContextLimits } from './context.js';
import type {
  AdapterResolution,
  PrefetchResult,
  RegisterTargetOptions,
  RegisterTargetResult,
  WebBackendAdapter,
} from './adapter.js';
import type {
  CanonicalContext,
  Decision,
  DecisionReason,
  Exposure,
  JsonValue,
  LifecycleState,
  ReleaseContext,
  Signal,
} from './types.js';

export type ExpectedFlagType = 'boolean' | 'string' | 'number' | 'object';

/** Ceiling on the initial prefetch so a hung backend cannot block boot. */
export const DEFAULT_FLAGS_READY_TIMEOUT_MS = 5_000;

export interface FireweaveWebRuntimeConfig {
  /** Context applied to every evaluation unless overridden per call. */
  readonly globalContext?: ContextInput;
  readonly limits?: Partial<ContextLimits>;
  readonly flagsReadyTimeoutMs?: number;
  /** Restrict prefetch to a known set of control points. */
  readonly flagKeys?: readonly string[];
  /** Emit a Fireweave exposure on each successful evaluation. Default false. */
  readonly sendExposure?: boolean;
}

function matchesExpectedType(value: JsonValue | undefined, expected: ExpectedFlagType): boolean {
  switch (expected) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'object':
      return typeof value === 'object' && value !== null;
  }
}

export class FireweaveWebRuntime {
  readonly adapter: WebBackendAdapter;
  readonly config: FireweaveWebRuntimeConfig;

  private state: LifecycleState = 'UNINITIALIZED';
  private cache: PrefetchResult = new Map();
  private globalContext: ContextInput;
  private readonly limits: ContextLimits;
  private releaseContext: ReleaseContext = {};
  private readonly listeners = new Set<(state: LifecycleState) => void>();

  constructor(adapter: WebBackendAdapter, config: FireweaveWebRuntimeConfig = {}) {
    this.adapter = adapter;
    this.config = config;
    this.globalContext = { ...(config.globalContext ?? {}) };
    this.limits = { ...DEFAULT_CONTEXT_LIMITS, ...(config.limits ?? {}) };
  }

  getState(): LifecycleState {
    return this.state;
  }

  onStateChange(listener: (state: LifecycleState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(next: LifecycleState): void {
    this.state = next;
    for (const l of this.listeners) l(next);
  }

  setReleaseContext(ctx: ReleaseContext): void {
    this.releaseContext = { ...ctx };
  }

  getReleaseContext(): ReleaseContext {
    return this.releaseContext;
  }

  /** Initialize the adapter and populate the cache. Never throws. */
  async initialize(context?: ContextInput): Promise<void> {
    if (this.state === 'SHUTDOWN') return;
    this.setState('INITIALIZING');
    if (context !== undefined) this.globalContext = mergeContexts(this.globalContext, context);

    try {
      await this.adapter.initialize();
    } catch {
      this.setState('ERROR');
      return;
    }
    await this.refresh();
  }

  /**
   * Replace the global context and re-prefetch — the identity-change path.
   *
   * Call this after sign-in with the user's stable id, so percentage ramps
   * bucket on that id rather than on an anonymous one. Returns the keys whose
   * decisions changed, so a provider can emit a targeted ConfigurationChanged.
   */
  async setContext(context: ContextInput): Promise<readonly string[]> {
    this.globalContext = { ...context };
    const before = this.cache;
    await this.refresh();
    return this.changedKeys(before, this.cache);
  }

  /** Re-run the prefetch against the current global context. */
  async refresh(): Promise<void> {
    if (this.state === 'SHUTDOWN') return;

    let canonical: CanonicalContext;
    try {
      canonical = canonicalizeContext(this.globalContext, this.limits);
    } catch {
      this.setState('ERROR');
      return;
    }

    const timeoutMs = this.config.flagsReadyTimeoutMs ?? DEFAULT_FLAGS_READY_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const TIMED_OUT = Symbol('timeout');

    const prefetch = this.adapter.prefetch(
      canonical,
      this.config.flagKeys !== undefined ? { flagKeys: this.config.flagKeys } : undefined
    );

    try {
      const result = await Promise.race([
        prefetch,
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
        }),
      ]);

      if (result === TIMED_OUT) {
        // Fail OPEN (boot continues) but not SILENT: reads will carry STALE and
        // the lifecycle says so. Swallow the late rejection so a slow failure
        // does not surface as an unhandled rejection minutes later.
        void prefetch.catch(() => undefined);
        this.setState('STALE');
        return;
      }

      this.cache = result;
      this.setState('READY');
    } catch {
      this.setState('STALE');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Synchronous evaluation against the prefetched cache. Never throws —
   * failures surface as ERROR decisions, exactly like the OpenFeature contract.
   */
  evaluateSync(
    flagKey: string,
    expectedType: ExpectedFlagType,
    defaultValue: JsonValue,
    invocationContext?: ContextInput
  ): Decision {
    if (this.state === 'SHUTDOWN') {
      return this.errorDecision(flagKey, defaultValue, new FireweaveError('AlreadyClosed'));
    }
    if (this.state === 'UNINITIALIZED' || this.state === 'INITIALIZING') {
      return this.errorDecision(flagKey, defaultValue, new FireweaveError('NotReady'));
    }
    if (this.state === 'ERROR') {
      return this.errorDecision(flagKey, defaultValue, new FireweaveError('BackendUnavailable'));
    }

    const resolution = this.cache.get(flagKey);
    if (resolution === undefined || resolution.found === false) {
      // A cache miss while STALE is not a missing control point — it is an
      // unanswered question. Reporting FLAG_NOT_FOUND there would send a caller
      // hunting for a flag that may well exist.
      if (this.state === 'STALE') {
        return {
          flagKey,
          value: defaultValue,
          reason: 'STALE',
          variant: 'default',
          metadata: { 'fireweave.stale': true },
        };
      }
      return this.errorDecision(flagKey, defaultValue, new FireweaveError('FlagNotFound'));
    }

    const value = resolution.value ?? null;
    if (!matchesExpectedType(value, expectedType)) {
      return this.errorDecision(flagKey, defaultValue, new FireweaveError('TypeMismatch'));
    }

    const metadata = this.metadataFor(resolution);
    const decision: Decision = {
      flagKey,
      value,
      reason: this.reasonFor(resolution),
      ...(resolution.variant !== undefined ? { variant: resolution.variant } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    };

    if (this.config.sendExposure === true) {
      this.recordExposureFor(decision, invocationContext);
    }
    return decision;
  }

  private reasonFor(resolution: AdapterResolution): DecisionReason {
    if (resolution.enabled === false) return 'DISABLED';
    if (resolution.reason !== undefined) return resolution.reason;
    if (this.state === 'STALE') return 'STALE';
    return 'TARGETING_MATCH';
  }

  private metadataFor(
    resolution: AdapterResolution
  ): Record<string, string | number | boolean> | undefined {
    const metadata: Record<string, string | number | boolean> = {};
    if (resolution.version !== undefined) metadata['fireweave.flagVersion'] = resolution.version;
    if (resolution.reasonCode !== undefined) metadata['fireweave.reasonCode'] = resolution.reasonCode;
    if (resolution.quotaLimited === true) metadata['fireweave.quotaLimited'] = true;
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  private recordExposureFor(decision: Decision, invocationContext?: ContextInput): void {
    if (this.adapter.recordExposure === undefined) return;
    const merged = mergeContexts(this.globalContext, invocationContext);
    const targetingKey = typeof merged.targetingKey === 'string' ? merged.targetingKey : '';
    if (targetingKey === '') return;
    const rc = this.releaseContext;
    const exposure: Exposure = {
      flagKey: decision.flagKey,
      targetingKey,
      value: decision.value,
      ...(decision.variant !== undefined ? { variant: decision.variant } : {}),
      ...(rc.rolloutId !== undefined ? { rolloutId: rc.rolloutId } : {}),
      ...(rc.changeId !== undefined ? { changeId: rc.changeId } : {}),
      ...(rc.stampId !== undefined ? { stampId: rc.stampId } : {}),
    };
    this.adapter.recordExposure(exposure);
  }

  recordExposure(exposure: Exposure): void {
    this.adapter.recordExposure?.(exposure);
  }

  recordSignal(signal: Signal): void {
    this.adapter.recordSignal?.(signal);
  }

  async registerTarget(
    targetingKey: string,
    options: RegisterTargetOptions = {}
  ): Promise<RegisterTargetResult> {
    if (this.state === 'SHUTDOWN') {
      return { ok: false, error: new FireweaveError('AlreadyClosed') };
    }
    if (this.adapter.registerTarget === undefined) {
      return { ok: false, error: new FireweaveError('UnsupportedCapability') };
    }
    try {
      return await this.adapter.registerTarget(targetingKey, options);
    } catch (err) {
      return {
        ok: false,
        error: isFireweaveError(err) ? err : new FireweaveError('BackendUnavailable'),
      };
    }
  }

  async flush(options: { beacon?: boolean } = {}): Promise<void> {
    await this.adapter.flush?.(options);
  }

  async shutdown(): Promise<void> {
    if (this.state === 'SHUTDOWN') return;
    try {
      await this.adapter.shutdown();
    } catch {
      // never throw from shutdown
    }
    this.cache = new Map();
    this.setState('SHUTDOWN');
  }

  private changedKeys(before: PrefetchResult, after: PrefetchResult): readonly string[] {
    const keys = new Set<string>([...before.keys(), ...after.keys()]);
    const changed: string[] = [];
    for (const key of keys) {
      const a = before.get(key);
      const b = after.get(key);
      if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) changed.push(key);
    }
    return changed;
  }

  private errorDecision(
    flagKey: string,
    defaultValue: JsonValue,
    err: FireweaveError
  ): Decision {
    return {
      flagKey,
      value: defaultValue,
      reason: 'ERROR',
      errorCode: err.openFeatureErrorCode,
      errorKind: err.kind,
      errorMessage: err.message,
      metadata: { 'fireweave.errorKind': err.kind, ...err.metadata },
    };
  }
}
