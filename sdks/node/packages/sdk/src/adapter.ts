import type { CanonicalContext, DecisionReason, Exposure, FlagValueType, JsonValue } from './types.js';

/** Result of a backend flag resolution (success path; faults throw FireweaveError). */
export interface AdapterResolution {
  found: boolean;
  /** Flag enabled state; false ⇒ DISABLED reason with the flag's stored value. */
  enabled?: boolean;
  value?: JsonValue;
  variant?: string;
  /** Declared flag type when known (in-memory fixtures); adapters may omit. */
  flagType?: FlagValueType | 'integer' | 'float';
  /** Adapter-suggested reason override (e.g. SPLIT, STALE). */
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
  readonly name: 'inmemory' | 'posthog' | 'other';
  /** Bring the backend to a usable state. Reject with FireweaveError on failure. */
  initialize(signal?: AbortSignal): Promise<void>;
  /** Resolve one flag. Throws FireweaveError for transport/auth/parse faults. */
  resolve(flagKey: string, context: CanonicalContext, options?: ResolveOptions): Promise<AdapterResolution>;
  /** Record an exposure event (optional capability). */
  recordExposure?(exposure: Exposure): void;
  /** Flush buffered telemetry/exposures. */
  flush?(): Promise<void>;
  /** Release resources; must be idempotent. */
  shutdown(): Promise<void>;
  /** Runtime feature capabilities contributed by this adapter. */
  features(): AdapterRuntimeFeatures;
}
