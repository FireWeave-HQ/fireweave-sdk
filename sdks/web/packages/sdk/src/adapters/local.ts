/**
 * Local development adapter for the browser — the DEV substrate of a
 * scaffolded web harness, and the exact peer of the server SDK's
 * `FireweaveLocalAdapter`.
 *
 * A key present in `devFlags` resolves with reason `STATIC`; every other key
 * misses, which the runtime turns into the caller's own default. No network,
 * no credentials, nothing to configure.
 *
 * Call-site defaults stay `false` under RAMP-1. Never write `flag(key, true)`
 * to dogfood locally — that same `true` is the production fallback when a
 * control point is absent from the provider, so it silently ships the ON
 * branch. Use `devFlags`.
 */
import type {
  AdapterResolution,
  AdapterRuntimeFeatures,
  PrefetchOptions,
  PrefetchResult,
  WebBackendAdapter,
} from '../adapter.js';
import type { CanonicalContext } from '../types.js';

export interface FireweaveLocalWebAdapterOptions {
  readonly devFlags?: Record<string, boolean>;
}

export class FireweaveLocalWebAdapter implements WebBackendAdapter {
  /** Not `inmemory` — that name belongs to the fixture adapter. */
  readonly name = 'other' as const;
  /**
   * spec/modes.md "Behaviour per mode": local's unknown-key row is
   * `default`/reason `DEFAULT`, not an error. This is the strict `===` seam
   * `FireweaveWebRuntime.evaluateSync` checks on a cache miss.
   */
  readonly missReason = 'DEFAULT' as const;

  private readonly devFlags: Record<string, boolean>;
  private closed = false;

  constructor(options: FireweaveLocalWebAdapterOptions = {}) {
    this.devFlags = { ...(options.devFlags ?? {}) };
  }

  async initialize(_signal?: AbortSignal): Promise<void> {
    // Nothing to connect to.
  }

  /**
   * `enabled: true` alongside `reason: 'STATIC'` is deliberate: reporting
   * `enabled: false` for an override of `false` would make the runtime label
   * the decision `DISABLED`, which means "exists but switched off upstream" —
   * not what a local override expresses.
   */
  async prefetch(_context: CanonicalContext, _options?: PrefetchOptions): Promise<PrefetchResult> {
    const out = new Map<string, AdapterResolution>();
    for (const [key, value] of Object.entries(this.devFlags)) {
      out.set(key, {
        found: true,
        enabled: true,
        value,
        variant: value ? 'on' : 'off',
        reason: 'STATIC',
        flagType: 'boolean',
      });
    }
    return out;
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
      // No exposure sink exists locally; claiming otherwise would advertise
      // emission that silently goes nowhere.
      exposureEmission: false,
      sideEffectFreeReads: true,
      groupAnalytics: false,
    };
  }
}
