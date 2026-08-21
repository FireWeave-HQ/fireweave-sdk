/**
 * Canonical data shapes, mirroring `spec/decision.schema.json`,
 * `spec/signal.schema.json`, and `spec/release-context.schema.json`.
 *
 * Identical in meaning to the server SDK's `types.ts`. Duplicated rather than
 * shared so the browser package has no cross-package dependency to audit; the
 * JSON Schemas in `spec/` are what keep the two honest.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type FlagValueType = 'boolean' | 'string' | 'number' | 'object';

export type DecisionReason =
  | 'STATIC'
  | 'DEFAULT'
  | 'TARGETING_MATCH'
  | 'SPLIT'
  | 'CACHED'
  | 'STALE'
  | 'DISABLED'
  | 'UNKNOWN'
  | 'ERROR';

export interface Decision {
  readonly flagKey: string;
  readonly value: JsonValue;
  readonly reason: DecisionReason;
  readonly variant?: string;
  readonly errorCode?: string;
  readonly errorKind?: string;
  readonly errorMessage?: string;
  readonly metadata?: Record<string, string | number | boolean>;
}

/**
 * A browser lifecycle has one state the server does not: STALE.
 *
 * It means "initialize completed, but the prefetch did not, so reads are being
 * served from an empty or outdated cache". Collapsing it into READY would make
 * a failed boot indistinguishable from a successful one — which is the specific
 * failure this SDK is written to avoid.
 */
export type LifecycleState =
  | 'UNINITIALIZED'
  | 'INITIALIZING'
  | 'READY'
  | 'STALE'
  | 'ERROR'
  | 'SHUTDOWN';

export interface CanonicalContext {
  readonly targetingKey?: string;
  readonly attributes: Record<string, JsonValue>;
  readonly groups?: Record<string, string>;
  readonly groupProperties?: Record<string, Record<string, JsonValue>>;
}

export type SignalKind = 'health' | 'error' | 'metric' | 'outcome';

export interface Signal {
  readonly kind: SignalKind;
  readonly name: string;
  readonly targetingKey?: string;
  readonly flagKey?: string;
  readonly variant?: string;
  readonly status?: string;
  readonly errorKind?: string;
  readonly message?: string;
  readonly value?: number;
  readonly rolloutId?: string;
  readonly changeId?: string;
  readonly stampId?: string;
  readonly timestamp?: string;
}

export interface Exposure {
  readonly flagKey: string;
  readonly targetingKey: string;
  readonly value: JsonValue;
  readonly variant?: string;
  readonly rolloutId?: string;
  readonly changeId?: string;
  readonly stampId?: string;
}

export type ReleaseState = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface ReleaseContext {
  readonly rolloutId?: string;
  readonly changeId?: string;
  readonly stampId?: string;
  readonly environment?: string;
}

export interface Capabilities {
  readonly static: {
    readonly language: 'web';
    readonly sdkVersion: string;
    readonly specVersion: string;
    readonly openFeature: {
      readonly specFloor: string;
      readonly providerName: string;
      readonly serverOnly: boolean;
    };
    readonly features: Record<string, boolean>;
  };
  readonly runtime: {
    readonly backend: 'fireweave' | 'inmemory' | 'none' | 'other';
    readonly lifecycle: LifecycleState;
    readonly features: Record<string, boolean>;
    readonly limits: Record<string, number>;
  };
}
