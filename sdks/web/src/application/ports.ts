/**
 * Backend adapter boundary for the browser.
 *
 * One shape differs from the server port, and it is the difference that makes
 * a synchronous OpenFeature provider possible: the server port has
 * `resolve(flagKey)` — one call per control point — while this port has
 * `prefetch(context)`, which returns EVERY decision for a context in one round
 * trip. Evaluation then becomes a synchronous map lookup in the runtime.
 *
 * The reason is not performance, it is the OpenFeature web contract:
 * `resolve*Evaluation` must return `ResolutionDetails`, not a Promise. Anything
 * the provider needs at read time must already be in memory.
 *
 * Adapters translate canonical requests to the Fireweave remote protocol; they
 * never see OpenFeature types.
 */
import type { CanonicalContext, DecisionReason, Exposure, FlagValueType, JsonValue, Signal } from '../domain/types.js';
import type { FireweaveError } from '../domain/errors.js';
import type { TargetKind } from '../domain/target.js';

export interface AdapterResolution {
  found: boolean;
  enabled?: boolean;
  value?: JsonValue;
  variant?: string;
  flagType?: FlagValueType;
  reason?: DecisionReason;
  reasonCode?: string;
  version?: number;
  payload?: JsonValue;
  quotaLimited?: boolean;
}

/** Every decision the backend returned for one context, keyed by control point. */
export type PrefetchResult = ReadonlyMap<string, AdapterResolution>;

export interface PrefetchOptions {
  /** Restrict the batch to these keys; omit to let the backend return all it knows. */
  readonly flagKeys?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface RegisterTargetOptions {
  readonly kind?: TargetKind;
  readonly properties?: Record<string, JsonValue>;
  readonly environment?: string;
  readonly signal?: AbortSignal;
}

export interface RegisterTargetResult {
  /**
   * `false` means the target was NOT registered — rules depending on its
   * properties will not match until a later attempt succeeds. Sign-in paths
   * normally ignore this; a careful caller logs it, because a silently
   * unregistered target is exactly how targeting ends up matching nobody.
   */
  readonly ok: boolean;
  readonly error?: FireweaveError;
}

export interface AdapterRuntimeFeatures {
  remoteEvaluation?: boolean;
  /** Always false in the browser, structurally — see ADR-0009. */
  localEvaluation?: boolean;
  localOnly?: boolean;
  exposureEmission?: boolean;
  sideEffectFreeReads?: boolean;
  groupAnalytics?: boolean;
}

export interface WebBackendAdapter {
  readonly name: 'fireweave' | 'inmemory' | 'other';
  /**
   * Miss-reason override for a control point ABSENT from the prefetch result
   * (spec/modes.md "Behaviour per mode": local mode's unknown-key row is
   * `default`/reason `DEFAULT`, not an error — unlike remote's
   * `default`/`ERROR`/`FlagNotFound`).
   *
   * Node's per-call `resolve()` lets a miss carry its own `reason: 'DEFAULT'`
   * on the resolution object itself. Web's adapter returns EVERY decision for
   * a context in one batch (`prefetch`), so there is no per-key resolution
   * object for a key that was never in the batch at all — the seam instead
   * lives on the adapter. `FireweaveLocalWebAdapter` sets this to `'DEFAULT'`;
   * every other adapter leaves it undefined and keeps the FlagNotFound/ERROR
   * path (`FireweaveWebRuntime.evaluateSync` checks it with strict `===`).
   */
  readonly missReason?: 'DEFAULT';
  /** Bring the backend to a usable state. Reject with FireweaveError on failure. */
  initialize(signal?: AbortSignal): Promise<void>;
  /** Fetch every decision for a context. Throws FireweaveError on transport faults. */
  prefetch(context: CanonicalContext, options?: PrefetchOptions): Promise<PrefetchResult>;
  /** Register a user or device for durable targeting. Resolves rather than throws. */
  registerTarget?(targetingKey: string, options?: RegisterTargetOptions): Promise<RegisterTargetResult>;
  recordExposure?(exposure: Exposure): void;
  recordSignal?(signal: Signal): void;
  /**
   * Deliver queued telemetry.
   *
   * `beacon: true` asks for an unload-safe transport (`sendBeacon` /
   * `keepalive`) because the page may be seconds from gone. Delivery is
   * best-effort by definition on that path — neither transport reports failure.
   */
  flush?(options?: { beacon?: boolean }): Promise<void>;
  shutdown(): Promise<void>;
  features(): AdapterRuntimeFeatures;
}
