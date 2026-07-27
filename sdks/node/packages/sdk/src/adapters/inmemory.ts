/**
 * Deterministic in-memory adapter for tests and conformance fixtures.
 * Resolution model mirrors contracts/ fixture flag definitions: flags, variants,
 * payloads, targeting by distinct_id / person attributes / groups.
 * Deliberately NO bucketing / percentage logic.
 */
import { FireweaveError, type FireweaveErrorKind } from '../errors.js';
import type { AdapterResolution, AdapterRuntimeFeatures, BackendAdapter, ResolveOptions } from '../adapter.js';
import type { CanonicalContext, DecisionReason, Exposure, JsonValue, Signal } from '../types.js';

export interface InMemoryFlagDefinition {
  type: 'boolean' | 'string' | 'integer' | 'float' | 'object';
  enabled: boolean;
  value: JsonValue;
  variant?: string;
  variants?: string[];
  payload?: JsonValue;
  reason?: { code?: string; condition_index?: number; description?: string };
  metadata?: { version?: number; id?: number };
  /** Canonical reason override (fixtures: "SPLIT"). */
  fireweaveReason?: DecisionReason;
  /** Served from last-good cache (stale scenarios). */
  fromCache?: boolean;
  /** Match only when all listed attributes deep-equal context attributes. */
  matchAttribute?: Record<string, JsonValue>;
  /** Match only when context groups contain these entries. */
  matchGroups?: Record<string, string>;
  /** Match only when person attributes contain these entries. */
  matchPerson?: Record<string, JsonValue>;
  /** Match only this exact targetingKey. */
  matchTargetingKey?: string;
}

export interface InMemoryFault {
  kind: FireweaveErrorKind;
  metadata?: Record<string, string | number | boolean>;
}

export interface InMemoryAdapterOptions {
  flags?: Record<string, InMemoryFlagDefinition>;
  /** Fault to throw on every resolve (fault-mode conformance without HTTP). */
  fault?: InMemoryFault;
  /** Reject initialize() with this error kind. */
  initError?: FireweaveErrorKind;
  /** Delay initialize() until release() is called (cold-start tests). */
  initGate?: { promise: Promise<void> };
}

function deepEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    return ak.length === bk.length && ak.every((k) => deepEqual(a[k], (b as Record<string, JsonValue>)[k]));
  }
  return false;
}

export class InMemoryAdapter implements BackendAdapter {
  readonly name = 'inmemory' as const;
  private flags: Map<string, InMemoryFlagDefinition>;
  private fault: InMemoryFault | undefined;
  private readonly initError: FireweaveErrorKind | undefined;
  private readonly initGate: { promise: Promise<void> } | undefined;
  private readonly exposures: Exposure[] = [];
  private readonly signals: Signal[] = [];
  private closed = false;

  constructor(options: InMemoryAdapterOptions = {}) {
    this.flags = new Map(Object.entries(options.flags ?? {}));
    this.fault = options.fault;
    this.initError = options.initError;
    this.initGate = options.initGate;
  }

  setFlags(flags: Record<string, InMemoryFlagDefinition>): void {
    this.flags = new Map(Object.entries(flags));
  }

  setFault(fault: InMemoryFault | undefined): void {
    this.fault = fault;
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    if (this.initError !== undefined) {
      throw new FireweaveError(this.initError);
    }
    if (this.initGate !== undefined) {
      if (signal?.aborted) throw new FireweaveError('Timeout');
      await this.initGate.promise;
    }
  }

  async resolve(flagKey: string, context: CanonicalContext, _options?: ResolveOptions): Promise<AdapterResolution> {
    if (this.fault !== undefined) {
      const opts = this.fault.metadata !== undefined ? { metadata: this.fault.metadata } : {};
      throw new FireweaveError(this.fault.kind, opts);
    }
    const def = this.flags.get(flagKey);
    if (def === undefined) {
      return { found: false };
    }
    if (!this.matches(def, context)) {
      return { found: false };
    }
    const resolution: AdapterResolution = {
      found: true,
      enabled: def.enabled,
      value: def.value,
      flagType: def.type,
    };
    if (def.variant !== undefined) resolution.variant = def.variant;
    if (def.fireweaveReason !== undefined) resolution.reason = def.fireweaveReason;
    if (def.reason?.code !== undefined) resolution.reasonCode = def.reason.code;
    if (def.reason?.condition_index !== undefined) resolution.conditionIndex = def.reason.condition_index;
    if (def.metadata?.version !== undefined) resolution.version = def.metadata.version;
    if (def.metadata?.id !== undefined) resolution.vendorFlagId = def.metadata.id;
    if (def.payload !== undefined) resolution.payload = def.payload;
    if (def.fromCache === true) resolution.fromCache = true;
    return resolution;
  }

  private matches(def: InMemoryFlagDefinition, context: CanonicalContext): boolean {
    if (def.matchTargetingKey !== undefined && context.targetingKey !== def.matchTargetingKey) {
      return false;
    }
    if (def.matchAttribute !== undefined) {
      for (const [k, v] of Object.entries(def.matchAttribute)) {
        if (!deepEqual(context.attributes[k], v)) return false;
      }
    }
    if (def.matchPerson !== undefined) {
      for (const [k, v] of Object.entries(def.matchPerson)) {
        if (!deepEqual(context.attributes[k], v)) return false;
      }
    }
    if (def.matchGroups !== undefined) {
      for (const [k, v] of Object.entries(def.matchGroups)) {
        if (context.groups?.[k] !== v) return false;
      }
    }
    return true;
  }

  recordExposure(exposure: Exposure): void {
    this.exposures.push(exposure);
  }

  getExposures(): readonly Exposure[] {
    return this.exposures;
  }

  recordSignal(signal: Signal): void {
    this.signals.push(signal);
  }

  getSignals(): readonly Signal[] {
    return this.signals;
  }

  async flush(): Promise<void> {
    // no-op: exposures stay queryable for tests
  }

  async shutdown(): Promise<void> {
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }

  features(): AdapterRuntimeFeatures {
    return {
      remoteEvaluation: false,
      localEvaluation: true,
      localOnly: true,
      exposureEmission: true,
      sideEffectFreeReads: true,
      groupAnalytics: true,
    };
  }
}
