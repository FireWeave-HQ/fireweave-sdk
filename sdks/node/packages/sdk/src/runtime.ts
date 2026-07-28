/**
 * FireweaveRuntime: shared engine behind the OpenFeature provider and the
 * FireweaveClient extensions. Owns lifecycle state machine, config validation,
 * context policy, and decision construction. Defaults never throw: evaluation
 * always returns a Decision.
 */
import { FireweaveError, isFireweaveError } from './errors.js';
import { assertHostAllowed } from './hosts.js';
import {
  DEFAULT_CONTEXT_LIMITS,
  DEFAULT_RESERVED_ATTRIBUTE_KEYS,
  canonicalizeContext,
  mergeContexts,
  type ContextInput,
  type ContextLimits,
  type ContextPolicy,
} from './context.js';
import type { AdapterResolution, BackendAdapter } from './adapter.js';
import type {
  CanonicalContext,
  Decision,
  DecisionReason,
  JsonValue,
  LifecycleState,
} from './types.js';

export type ExpectedFlagType = 'boolean' | 'string' | 'number' | 'object';

export interface FireweaveRuntimeConfig {
  /** PostHog project API key (phc_...) — required only for the PostHog adapter. */
  projectApiKey?: string;
  /** Backend host (must be http(s) and pass the allowlist). */
  host?: string;
  /**
   * SSRF allowlist: hostnames the SDK may talk to. Empty/undefined ⇒ the
   * canonical PostHog default allowlist + loopback (DEFAULT_ALLOWED_HOSTS).
   * Custom/self-hosted endpoints must be listed explicitly; ['*'] opts out.
   */
  allowedHosts?: readonly string[];
  /** Require targetingKey on every evaluation. */
  requireTargetingKey?: boolean;
  /** Context bound overrides (defaults are the ratified spec bounds). */
  limits?: Partial<ContextLimits>;
  /** Additional reserved attribute keys. */
  reservedAttributeKeys?: readonly string[];
  /** Shutdown flush deadline (ms). Default DEFAULT_SHUTDOWN_TIMEOUT_MS. */
  shutdownTimeoutMs?: number;
}

/** Default bound on shutdown/flush (matches capabilities.get()). */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;

export interface EvaluateOptions {
  /** Attach flag payload as fireweave.payload metadata (sorted-key JSON string). */
  includePayload?: boolean;
  /**
   * When true, emit a Fireweave-owned exposure for a successful evaluation
   * (H-4 / ADR-0001 §23 errata / ruling 20). Default `false` — phase-one
   * evaluate is side-effect-free. Vendor `$feature_flag_called` stays
   * suppressed on the local snapshot path (RB-2); Fireweave owns emission
   * and dedup when opted in.
   */
  sendExposure?: boolean;
  signal?: AbortSignal;
}

function validateConfig(config: FireweaveRuntimeConfig, adapterName: string): void {
  if (adapterName === 'posthog') {
    if (config.projectApiKey === undefined || config.projectApiKey.length === 0) {
      throw new FireweaveError('Configuration');
    }
  }
  if (config.host !== undefined) {
    // Allowlist is ON by default (release-blockers H-1): undefined/empty
    // allowedHosts falls back to the canonical PostHog + loopback list.
    assertHostAllowed(config.host, config.allowedHosts);
  }
  if (config.limits !== undefined) {
    for (const value of Object.values(config.limits)) {
      if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
        throw new FireweaveError('Configuration');
      }
    }
  }
}

/** JSON stringify with deterministic (sorted) key order at every level. */
export function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k] as JsonValue)}`).join(',')}}`;
}

function matchesExpectedType(value: JsonValue, expected: ExpectedFlagType): boolean {
  switch (expected) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'object':
      return value !== null && typeof value === 'object';
  }
}

export class FireweaveRuntime {
  readonly adapter: BackendAdapter;
  readonly config: FireweaveRuntimeConfig;
  private readonly contextPolicy: ContextPolicy;
  private state: LifecycleState = 'UNINITIALIZED';
  private globalContext: ContextInput | undefined;
  private clientContext: ContextInput | undefined;
  private initPromise: Promise<void> | undefined;
  private readonly stateListeners = new Set<(state: LifecycleState) => void>();
  /** Dedup window for evaluate/OF-path exposures (cleared on flush / shutdown). */
  private readonly evaluateExposureSeen = new Set<string>();

  constructor(adapter: BackendAdapter, config: FireweaveRuntimeConfig = {}) {
    this.adapter = adapter;
    this.config = { ...config };
    const limits: ContextLimits = { ...DEFAULT_CONTEXT_LIMITS, ...(config.limits ?? {}) };
    this.contextPolicy = {
      limits,
      reservedAttributeKeys: [
        ...DEFAULT_RESERVED_ATTRIBUTE_KEYS,
        ...(config.reservedAttributeKeys ?? []),
      ],
      requireTargetingKey: config.requireTargetingKey ?? false,
    };
  }

  /** Clear evaluate-path exposure dedup (M-2 / clear-on-flush lifecycle). */
  clearEvaluateExposureDedup(): void {
    this.evaluateExposureSeen.clear();
  }

  getState(): LifecycleState {
    return this.state;
  }

  onStateChange(listener: (state: LifecycleState) => void): void {
    this.stateListeners.add(listener);
  }

  private setState(next: LifecycleState): void {
    this.state = next;
    for (const listener of this.stateListeners) listener(next);
  }

  /** Mark definitions/cache staleness (adapter-driven). */
  markStale(): void {
    if (this.state === 'READY') this.setState('STALE');
  }

  setGlobalContext(context: ContextInput | undefined): void {
    this.globalContext = context;
  }

  setClientContext(context: ContextInput | undefined): void {
    this.clientContext = context;
  }

  /**
   * Initialize the runtime: validate config, then bring the adapter up.
   * Rejects with FireweaveError; Configuration errors put the runtime in FATAL.
   */
  async initialize(signal?: AbortSignal): Promise<void> {
    if (this.state === 'SHUTDOWN') {
      throw new FireweaveError('AlreadyClosed');
    }
    if (this.state === 'READY') return;
    if (this.initPromise !== undefined) return this.initPromise;

    this.initPromise = (async () => {
      this.setState('INITIALIZING');
      try {
        validateConfig(this.config, this.adapter.name);
      } catch (err) {
        this.setState('FATAL');
        throw err;
      }
      try {
        await this.adapter.initialize(signal);
        this.setState('READY');
      } catch (err) {
        if (isFireweaveError(err) && err.kind === 'Configuration') {
          this.setState('FATAL');
        } else {
          this.setState('ERROR');
        }
        throw isFireweaveError(err) ? err : new FireweaveError('Internal', { cause: err });
      } finally {
        this.initPromise = undefined;
      }
    })();
    return this.initPromise;
  }

  async shutdown(): Promise<void> {
    if (this.state === 'SHUTDOWN') return; // idempotent
    // The configured deadline bounds the whole flush+close sequence (M-1/L-4):
    // a wedged vendor client must not hang process exit.
    const timeoutMs = this.config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    const close = (async () => {
      try {
        await this.adapter.flush?.();
      } catch {
        // best-effort flush; never throw from shutdown
      }
      try {
        await this.adapter.shutdown();
      } catch {
        // swallow: shutdown must not throw
      }
    })();
    try {
      await Promise.race([close, deadline]);
    } finally {
      this.evaluateExposureSeen.clear();
      if (timer !== undefined) clearTimeout(timer);
      this.setState('SHUTDOWN');
    }
  }

  /** Canonicalize + validate the merged context (throws FireweaveError). */
  resolveContext(invocationContext: ContextInput | undefined): CanonicalContext {
    const merged = mergeContexts(this.globalContext, this.clientContext, invocationContext);
    return canonicalizeContext(merged, this.contextPolicy);
  }

  /**
   * Evaluate a flag to a canonical Decision. Never throws.
   */
  async evaluate(
    flagKey: string,
    expectedType: ExpectedFlagType,
    defaultValue: JsonValue,
    invocationContext?: ContextInput,
    options: EvaluateOptions = {},
  ): Promise<Decision> {
    const lifecycleError = this.lifecycleError();
    if (lifecycleError !== undefined) {
      return this.errorDecision(flagKey, defaultValue, lifecycleError);
    }

    let context: CanonicalContext;
    try {
      context = this.resolveContext(invocationContext);
    } catch (err) {
      const fw = isFireweaveError(err) ? err : new FireweaveError('InvalidContext', { cause: err });
      return this.errorDecision(flagKey, defaultValue, fw);
    }

    let resolution: AdapterResolution;
    try {
      const resolveOpts = options.signal !== undefined ? { signal: options.signal } : {};
      resolution = await this.adapter.resolve(flagKey, context, resolveOpts);
    } catch (err) {
      // H-2: non-Fireweave (vendor/internal) exception text never reaches the
      // outward errorMessage — the fixed taxonomy message is used and the
      // original error is preserved on `cause` only.
      const fw = isFireweaveError(err) ? err : new FireweaveError('Internal', { cause: err });
      return this.errorDecision(flagKey, defaultValue, fw);
    }

    if (!resolution.found) {
      const meta: Record<string, string | number | boolean> = {};
      if (resolution.quotaLimited === true) meta['fireweave.quotaLimited'] = true;
      return this.errorDecision(flagKey, defaultValue, new FireweaveError('FlagNotFound', { metadata: meta }));
    }

    const value = resolution.value ?? null;
    if (!matchesExpectedType(value, expectedType)) {
      return this.errorDecision(flagKey, defaultValue, new FireweaveError('TypeMismatch'));
    }

    const metadata: Record<string, string | number | boolean> = {};
    if (resolution.version !== undefined) metadata['fireweave.flagVersion'] = resolution.version;
    // Detailed vendor fields travel together: they surface only when the
    // backend reported BOTH a vendor flag id and a matched condition index
    // (fixtures: eval-detailed-fields exposes them; eval-multivariate-string
    // [index, no id] and eval-payload-attached [id, no index] do not).
    if (resolution.vendorFlagId !== undefined && resolution.conditionIndex !== undefined) {
      metadata['fireweave.vendorFlagId'] = resolution.vendorFlagId;
      if (resolution.reasonCode !== undefined) metadata['fireweave.reasonCode'] = resolution.reasonCode;
    }
    if (options.includePayload === true && resolution.payload !== undefined) {
      metadata['fireweave.payload'] =
        typeof resolution.payload === 'string' ? resolution.payload : stableStringify(resolution.payload);
    }
    if (resolution.quotaLimited === true) metadata['fireweave.quotaLimited'] = true;
    if (resolution.fromCache === true) metadata['fireweave.fromCache'] = true;

    let reason: DecisionReason;
    if (resolution.enabled === false) {
      reason = 'DISABLED';
    } else if (resolution.reason !== undefined) {
      reason = resolution.reason;
    } else if (resolution.fromCache === true || this.state === 'STALE') {
      reason = 'STALE';
    } else {
      reason = 'TARGETING_MATCH';
    }

    const decision: Decision = { flagKey, value, reason, metadata };
    if (resolution.variant !== undefined) decision.variant = resolution.variant;

    // H-4 / ruling 20: evaluate is side-effect-free by default; opt in via sendExposure: true.
    if (options.sendExposure === true) {
      this.emitEvaluateExposure({
        targetingKey: context.targetingKey ?? '',
        flagKey,
        value,
        ...(resolution.variant !== undefined ? { variant: resolution.variant } : {}),
      });
    }

    return decision;
  }

  private emitEvaluateExposure(exposure: {
    targetingKey: string;
    flagKey: string;
    value: JsonValue;
    variant?: string;
  }): void {
    if (exposure.targetingKey.length === 0) return;
    if (this.adapter.recordExposure === undefined) return;
    const key = `${exposure.targetingKey}\u0000${exposure.flagKey}\u0000${exposure.variant ?? ''}\u0000${stableStringify(exposure.value ?? null)}`;
    if (this.evaluateExposureSeen.has(key)) return;
    this.evaluateExposureSeen.add(key);
    this.adapter.recordExposure({
      targetingKey: exposure.targetingKey,
      flagKey: exposure.flagKey,
      value: exposure.value,
      ...(exposure.variant !== undefined ? { variant: exposure.variant } : {}),
    });
  }

  private lifecycleError(): FireweaveError | undefined {
    switch (this.state) {
      case 'UNINITIALIZED':
      case 'INITIALIZING':
        return new FireweaveError('NotReady');
      case 'ERROR':
        return new FireweaveError('NotReady');
      case 'FATAL':
        return new FireweaveError('Configuration');
      case 'SHUTDOWN':
        return new FireweaveError('AlreadyClosed');
      default:
        return undefined;
    }
  }

  private errorDecision(flagKey: string, defaultValue: JsonValue, err: FireweaveError): Decision {
    const metadata: Record<string, string | number | boolean> = {
      'fireweave.errorKind': err.kind,
      ...err.metadata,
    };
    return {
      flagKey,
      value: defaultValue,
      reason: 'ERROR',
      errorCode: err.openFeatureErrorCode,
      errorKind: err.kind,
      errorMessage: err.message,
      metadata,
    };
  }
}
