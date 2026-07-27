import type { FireweaveErrorKind, OpenFeatureErrorCode } from './errors.js';

/** JSON-compatible value (spec/decision.schema.json `value`). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

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

/** Canonical decision (spec/decision.schema.json). */
export interface Decision {
  flagKey: string;
  value: JsonValue;
  reason: DecisionReason;
  variant?: string;
  errorCode?: OpenFeatureErrorCode;
  errorKind?: FireweaveErrorKind;
  errorMessage?: string;
  /** fireweave.* flag metadata surfaced to OpenFeature flagMetadata. */
  metadata: Record<string, string | number | boolean>;
}

/** Canonical evaluation context after validation/canonicalization. */
export interface CanonicalContext {
  targetingKey?: string;
  /** All non-reserved attributes (targetingKey excluded). */
  attributes: Record<string, JsonValue>;
  /**
   * Group memberships extracted from `fireweave.groups` (canonical, ruling 13)
   * or the plain `groups` alias, when shaped as Record<string,string>.
   */
  groups?: Record<string, string>;
  /**
   * Group properties extracted from `fireweave.groupProperties` (canonical)
   * or the plain `groupProperties` alias.
   */
  groupProperties?: Record<string, JsonValue>;
}

export type LifecycleState =
  | 'UNINITIALIZED'
  | 'INITIALIZING'
  | 'READY'
  | 'STALE'
  | 'ERROR'
  | 'FATAL'
  | 'SHUTDOWN';

export type SignalKind = 'health' | 'error' | 'metric' | 'outcome';

/** Canonical signal envelope (spec/signal.schema.json). */
export interface Signal {
  kind: SignalKind;
  name: string;
  status?: string;
  errorKind?: FireweaveErrorKind;
  message?: string;
  value?: number | boolean | string;
  timestamp?: string;
  targetingKey?: string;
  rolloutId?: string;
  changeId?: string;
  stampId?: string;
  flagKey?: string;
  variant?: string;
  traceId?: string;
  role?: 'adoption' | 'guard' | 'quality' | 'custom';
  direction?: 'up-good' | 'up-bad' | 'neutral';
  attributes?: Record<string, string | number | boolean | null>;
}

/** Release / rollout context (spec/release-context.schema.json; ruling 15: rolloutId + stampIds required). */
export interface ReleaseContext {
  stampIds: string[];
  rolloutId: string;
  changeId?: string;
  surfaces?: Array<{
    surfaceId: string;
    kind?: 'ts-server' | 'node-server' | 'python' | 'go' | 'java' | 'web' | 'other';
  }>;
  metadata?: Record<string, string | number | boolean>;
}

export type ReleaseStatus = 'set' | 'in_progress' | 'completed' | 'failed';

export interface ReleaseState {
  context: ReleaseContext;
  status: ReleaseStatus;
  reason?: string;
}

/** Exposure event (extensions fixtures shape). */
export interface Exposure {
  targetingKey: string;
  flagKey: string;
  value: JsonValue;
  variant?: string;
  rolloutId?: string;
  changeId?: string;
  stampId?: string;
}

/** Capability matrix (spec/capabilities.schema.json). */
export interface Capabilities {
  static: {
    language: 'node';
    sdkVersion?: string;
    specVersion?: '0.1.0';
    openFeature: {
      specFloor: '0.8.0';
      providerName: 'fireweave';
      serverOnly?: boolean;
    };
    features: Record<string, boolean>;
  };
  runtime: {
    backend: 'posthog' | 'inmemory' | 'none' | 'other';
    lifecycle: LifecycleState;
    features?: Record<string, boolean>;
    limits?: {
      intSafeMaxAbs?: number;
      shutdownTimeoutMsDefault?: number;
    };
  };
}
