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
  RegisterTargetOptions,
  RegisterTargetResult,
  WebBackendAdapter,
} from '../../application/ports.js';
import type { TargetKind } from '../../domain/target.js';
import type { CanonicalContext } from '../../domain/types.js';

export interface FireweaveLocalWebAdapterOptions {
  readonly devFlags?: Record<string, boolean>;
  /**
   * Sink for the `[fireweave:local]` registerTarget trace line
   * (spec/modes.md "registerTarget in local mode"). Defaults to
   * `console.info`.
   */
  readonly log?: (message: string) => void;
}

/** A target recorded by {@link FireweaveLocalWebAdapter.registerTarget}. */
export interface LocalRegisteredTarget {
  readonly targetingKey: string;
  readonly kind: TargetKind;
  readonly properties: Record<string, unknown>;
  readonly environment?: string;
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
  private readonly log: (message: string) => void;
  private readonly targets = new Map<string, LocalRegisteredTarget>();
  private closed = false;

  constructor(options: FireweaveLocalWebAdapterOptions = {}) {
    this.devFlags = { ...(options.devFlags ?? {}) };
    this.log = options.log ?? ((m) => console.info(m));
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

  /**
   * Records the target in-process and traces it, rather than reporting
   * `UnsupportedCapability`.
   *
   * The capability could instead report Unsupported so a dev harness could
   * not *silently* look registered — but the failure being guarded against
   * is a developer believing their targeting works because nothing objected.
   * A recorded target plus an explicit `[fireweave:local]` line preserves
   * that guarantee by a different route: nothing is silent, and local dev
   * can exercise targeting rules offline instead of only in production
   * (spec/modes.md "registerTarget in local mode").
   *
   * The trace names the mode, so a line appearing in a production log is
   * itself the signal that something booted in local mode by mistake.
   *
   * No network call is made and nothing reaches fw-server.
   */
  async registerTarget(
    targetingKey: string,
    options: RegisterTargetOptions = {}
  ): Promise<RegisterTargetResult> {
    const kind: TargetKind = options.kind ?? 'user';
    const properties = { ...(options.properties ?? {}) };
    const target: LocalRegisteredTarget = {
      targetingKey,
      kind,
      properties,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
    };
    this.targets.set(targetingKey, target);
    this.log(
      `[fireweave:local] registerTarget ${kind} ${targetingKey} ` +
        `${JSON.stringify(properties)} — recorded in-process, NOT sent to fw-server`
    );
    return { ok: true };
  }

  /** Targets recorded this process, for assertions and dev inspection. */
  getRegisteredTargets(): readonly LocalRegisteredTarget[] {
    return [...this.targets.values()];
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
