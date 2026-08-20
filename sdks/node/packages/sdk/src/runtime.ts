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
  mergeContexts,
  type ContextInput,
  type ContextLimits,
  type ContextPolicy,
} from './context.js';
import {
  matchesExpectedType,
  validateContext,
  validateControlPointKey,
  validateDefaultValue,
  type ExpectedFlagType,
} from './validation.js';
import type {
  AdapterResolution,
  BackendAdapter,
  RegisterTargetOptions,
  RegisterTargetResult,
} from './adapter.js';
import type {
  CanonicalContext,
  Decision,
  DecisionReason,
  JsonValue,
  LifecycleState,
} from './types.js';

export type { ExpectedFlagType } from './validation.js';

export interface FireweaveRuntimeConfig {
  /**
   * Fireweave project/runtime key (`project-api-key_…`). Adapters may also read
   * it from their own options or `FW_PROJECT_API_KEY`.
   */
  projectApiKey?: string;
  /** Backend host (must be http(s) and pass the allowlist). */
  host?: string;
  /**
   * SSRF allowlist: hostnames the SDK may talk to. Empty/undefined ⇒ the
   * canonical Fireweave default allowlist + loopback (DEFAULT_ALLOWED_HOSTS).
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

function validateConfig(config: FireweaveRuntimeConfig): void {
  if (config.host !== undefined) {
    // Allowlist is ON by default (release-blockers H-1): undefined/empty
    // allowedHosts falls back to the canonical Fireweave + loopback list.
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
        validateConfig(this.config);
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
    const result = validateContext(merged, this.contextPolicy);
    if (!result.ok) throw result.error;
    return result.value;
  }

  /**
   * Evaluate a flag to a canonical Decision. Never throws.
   *
   * Validates in the fixed order spec/control-points.md "Validation, before
   * any I/O" names, stopping at the first failure: (1) key, (2) default vs
   * type, (3) context, (4) lifecycle. Only once all four pass does this
   * reach the adapter (the one I/O call in this method).
   */
  async evaluate(
    flagKey: string,
    expectedType: ExpectedFlagType,
    defaultValue: JsonValue,
    invocationContext?: ContextInput,
    options: EvaluateOptions = {},
  ): Promise<Decision> {
    const keyResult = validateControlPointKey(flagKey);
    if (!keyResult.ok) {
      return this.errorDecision(flagKey, defaultValue, keyResult.error);
    }

    const defaultResult = validateDefaultValue(expectedType, defaultValue);
    if (!defaultResult.ok) {
      return this.errorDecision(flagKey, defaultValue, defaultResult.error);
    }

    const merged = mergeContexts(this.globalContext, this.clientContext, invocationContext);
    const contextResult = validateContext(merged, this.contextPolicy);
    if (!contextResult.ok) {
      return this.errorDecision(flagKey, defaultValue, contextResult.error);
    }
    const context = contextResult.value;

    const lifecycleError = this.lifecycleError();
    if (lifecycleError !== undefined) {
      return this.errorDecision(flagKey, defaultValue, lifecycleError);
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
      // spec/modes.md "Behaviour per mode": local's unknown-key row is
      // `default` / `reason: DEFAULT` — deliberately not an error, unlike
      // remote's `default` / `ERROR` / `FlagNotFound`. An adapter signals the
      // former by carrying `reason: 'DEFAULT'` on its miss (FireweaveLocalAdapter);
      // any adapter that leaves `reason` unset (InMemoryAdapter,
      // FireweaveRemoteAdapter) keeps the FlagNotFound/ERROR path below.
      if (resolution.reason === 'DEFAULT') {
        return { flagKey, value: defaultValue, reason: 'DEFAULT', metadata: {} };
      }
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

  /**
   * Register a user or device so flag rules can target its DURABLE properties.
   *
   * Call once per login / device provisioning with the facts that outlive a
   * request (plan, beta membership, region, device model), then send the same
   * `targetingKey` on evaluation. Per-request context attributes still override
   * the registered properties for a single evaluation — the two identity paths
   * compose (spec/remote-protocol.md § Two identity paths).
   *
   * Resolves with `ok: false` instead of throwing: this runs in sign-in paths.
   * Adapters without the capability (in-memory, local dev) report
   * `Unsupported` so a dev harness does not silently look registered.
   */
  async registerTarget(
    targetingKey: string,
    options: RegisterTargetOptions = {},
  ): Promise<RegisterTargetResult> {
    const lifecycle = this.lifecycleError();
    if (lifecycle !== undefined) return { ok: false, error: lifecycle };
    if (this.adapter.registerTarget === undefined) {
      return { ok: false, error: new FireweaveError('UnsupportedCapability') };
    }
    return this.adapter.registerTarget(targetingKey, options);
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
