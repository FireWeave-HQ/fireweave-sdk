import type { FireweaveError } from './errors.js';
import type { CanonicalContext, DecisionReason, Exposure, FlagValueType, JsonValue, Signal } from './types.js';

/** What is being registered — see spec/remote-register-target.schema.json. */
export type TargetKind = 'user' | 'device';

export interface RegisterTargetOptions {
  /** Defaults to 'user'. */
  kind?: TargetKind;
  /** Durable targeting facts: plan, beta membership, region, device model. */
  properties?: Record<string, JsonValue>;
  /** Client-declared environment (production, staging, …). */
  environment?: string;
  signal?: AbortSignal;
}

export interface RegisterTargetResult {
  /**
   * `false` means the target was NOT registered — rules that depend on its
   * properties will not match until a later attempt succeeds. Callers in a
   * login path normally ignore this; a careful caller logs it, because a
   * silently unregistered target is exactly how targeting rules end up
   * matching nobody.
   */
  readonly ok: boolean;
  readonly error?: FireweaveError;
}

/** Result of a backend flag resolution (success path; faults throw FireweaveError). */
export interface AdapterResolution {
  found: boolean;
  /** Flag enabled state; false ⇒ DISABLED reason with the flag's stored value. */
  enabled?: boolean;
  value?: JsonValue;
  variant?: string;
  /** Declared flag type when known (in-memory fixtures); adapters may omit. */
  flagType?: FlagValueType | 'integer' | 'float';
  /**
   * Adapter-suggested reason override (e.g. SPLIT, STALE) on a `found: true`
   * resolution. On a `found: false` miss, `reason: 'DEFAULT'` instead signals
   * the runtime to return the caller's default with reason `DEFAULT` — not an
   * error — per local mode's unknown-key row (spec/modes.md; see
   * FireweaveLocalAdapter.resolve).
   */
  reason?: DecisionReason;
  /** Vendor reason code (e.g. "condition_match"). */
  reasonCode?: string;
  /** Vendor condition index when the vendor reports one. */
  conditionIndex?: number;
  /** Flag definition version. */
  version?: number;
  /** Vendor-side numeric flag id. */
  vendorFlagId?: number;
  /** Optional flag payload (object or pre-serialized JSON string). */
  payload?: JsonValue;
  /** True when the /flags response reported quota limiting. */
  quotaLimited?: boolean;
  /** True when served from a stale/last-good cache. */
  fromCache?: boolean;
}

export interface ResolveOptions {
  signal?: AbortSignal;
}

export interface AdapterRuntimeFeatures {
  remoteEvaluation?: boolean;
  localEvaluation?: boolean;
  localOnly?: boolean;
  exposureEmission?: boolean;
  sideEffectFreeReads?: boolean;
  groupAnalytics?: boolean;
}

/**
 * Backend adapter boundary (docs/architecture.md §layers). Adapters translate
 * canonical requests to vendor protocols; they never see OpenFeature types.
 */
export interface BackendAdapter {
  /** Third-party adapters use 'other'; the vendor is fw-server's concern. */
  readonly name: 'inmemory' | 'fireweave' | 'other';
  /** Bring the backend to a usable state. Reject with FireweaveError on failure. */
  initialize(signal?: AbortSignal): Promise<void>;
  /** Resolve one flag. Throws FireweaveError for transport/auth/parse faults. */
  resolve(flagKey: string, context: CanonicalContext, options?: ResolveOptions): Promise<AdapterResolution>;
  /**
   * Register a user or device so rules can target its durable properties
   * (optional capability). Resolves with `ok: false` rather than throwing —
   * registration sits in login paths and must not break sign-in.
   */
  registerTarget?(
    targetingKey: string,
    options?: RegisterTargetOptions,
  ): Promise<RegisterTargetResult>;
  /** Record an exposure event (optional capability). */
  recordExposure?(exposure: Exposure): void;
  /** Deliver a telemetry signal to the backend sink (optional capability, ruling 17). */
  recordSignal?(signal: Signal): void;
  /** Flush buffered telemetry/exposures. */
  flush?(): Promise<void>;
  /** Release resources; must be idempotent. */
  shutdown(): Promise<void>;
  /** Runtime feature capabilities contributed by this adapter. */
  features(): AdapterRuntimeFeatures;
}
