/**
 * In-memory adapter — offline evaluation for tests and conformance fixtures.
 *
 * Declares control points up front and serves them from memory. Fault
 * injection exists so the conformance suite can drive the error taxonomy
 * without a network or a stub server.
 */
import { FireweaveError, type FireweaveErrorKind } from '../errors.js';
import type {
  AdapterResolution,
  AdapterRuntimeFeatures,
  PrefetchOptions,
  PrefetchResult,
  WebBackendAdapter,
} from '../adapter.js';
import type { CanonicalContext, Exposure, FlagValueType, JsonValue, Signal } from '../types.js';

export interface InMemoryFlagDefinition {
  readonly type: FlagValueType;
  readonly enabled: boolean;
  readonly value: JsonValue;
  readonly variant?: string;
  readonly payload?: JsonValue;
  /** Only resolve for this targeting key; otherwise the control point misses. */
  readonly matchTargetingKey?: string;
  readonly fireweaveReason?: AdapterResolution['reason'];
}

export interface InMemoryFault {
  readonly kind: FireweaveErrorKind;
  /** Throw on initialize rather than on prefetch. */
  readonly onInitialize?: boolean;
}

export interface InMemoryWebAdapterOptions {
  readonly flags?: Record<string, InMemoryFlagDefinition>;
  readonly fault?: InMemoryFault;
}

export class InMemoryWebAdapter implements WebBackendAdapter {
  readonly name = 'inmemory' as const;

  private flags: Map<string, InMemoryFlagDefinition>;
  private fault: InMemoryFault | undefined;
  private readonly exposures: Exposure[] = [];
  private readonly signals: Signal[] = [];
  private closed = false;

  constructor(options: InMemoryWebAdapterOptions = {}) {
    this.flags = new Map(Object.entries(options.flags ?? {}));
    this.fault = options.fault;
  }

  setFlags(flags: Record<string, InMemoryFlagDefinition>): void {
    this.flags = new Map(Object.entries(flags));
  }

  setFault(fault: InMemoryFault | undefined): void {
    this.fault = fault;
  }

  async initialize(_signal?: AbortSignal): Promise<void> {
    if (this.fault?.onInitialize === true) throw new FireweaveError(this.fault.kind);
  }

  async prefetch(context: CanonicalContext, options?: PrefetchOptions): Promise<PrefetchResult> {
    if (this.fault !== undefined && this.fault.onInitialize !== true) {
      throw new FireweaveError(this.fault.kind);
    }
    const wanted = options?.flagKeys;
    const out = new Map<string, AdapterResolution>();
    for (const [key, def] of this.flags) {
      if (wanted !== undefined && wanted.length > 0 && !wanted.includes(key)) continue;
      if (def.matchTargetingKey !== undefined && context.targetingKey !== def.matchTargetingKey) {
        out.set(key, { found: false });
        continue;
      }
      const resolution: AdapterResolution = {
        found: true,
        enabled: def.enabled,
        value: def.value,
        flagType: def.type,
      };
      if (def.variant !== undefined) resolution.variant = def.variant;
      if (def.payload !== undefined) resolution.payload = def.payload;
      if (def.fireweaveReason !== undefined) resolution.reason = def.fireweaveReason;
      out.set(key, resolution);
    }
    return out;
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
    // no-op: telemetry stays queryable for tests
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
      localEvaluation: false,
      localOnly: true,
      exposureEmission: true,
      sideEffectFreeReads: true,
      groupAnalytics: false,
    };
  }
}
