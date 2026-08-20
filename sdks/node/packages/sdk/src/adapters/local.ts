/**
 * Local development adapter — the DEV substrate for a scaffolded harness.
 *
 * It is the counterpart to {@link FireweaveRemoteAdapter}: prod evaluates
 * control points against fw-server, dev evaluates them here, in-process, with
 * no network and no credentials. Because it satisfies the same
 * {@link BackendAdapter} port, the dev branch of a harness runs through the
 * same {@link FireweaveRuntime} as prod — inheriting identical lifecycle
 * gating and context canonicalization. That symmetry is the point: dev/prod
 * skew in the harness is exactly what the harness exists to prevent.
 *
 * Resolution policy is deliberately minimal:
 *
 * - a key present in `devFlags` resolves to its mapped value with reason
 *   `STATIC` — the only supported way to turn a control point ON (or force it
 *   OFF) on a laptop;
 * - every other key MISSES (`{ found: false }`), which the runtime turns into
 *   the caller's own default.
 *
 * Call-site defaults stay `false` under RAMP-1. Never write
 * `fw.flag(key, true)` to dogfood locally — that same `true` is the production
 * fallback when the control point is absent from the provider, so it silently
 * ships the ON branch. Use `devFlags` instead.
 *
 * Runtime portability: pure computation, no I/O, no env, no Node globals — so
 * it runs unchanged on Node, Bun, and Deno (ADR-0008), and is covered by
 * `test/unit/runtime-portability.test.ts`.
 */
import type {
  AdapterResolution,
  AdapterRuntimeFeatures,
  BackendAdapter,
  RegisterTargetOptions,
  RegisterTargetResult,
  ResolveOptions,
  TargetKind,
} from '../adapter.js';
import type { CanonicalContext } from '../types.js';

export interface FireweaveLocalAdapterOptions {
  /**
   * Per-key boolean overrides. A present key resolves to its mapped value with
   * reason `STATIC`; an absent key misses so the caller's default is used.
   */
  readonly devFlags?: Record<string, boolean>;
  /**
   * Sink for the local `registerTarget` trace. Defaults to `console.info`.
   * Injectable so tests assert the call without capturing stdout, and so a
   * host that owns its logging can route it.
   */
  readonly log?: (message: string) => void;
}

/** A target recorded by {@link FireweaveLocalAdapter.registerTarget}. */
export interface LocalRegisteredTarget {
  readonly targetingKey: string;
  readonly kind: TargetKind;
  readonly properties: Record<string, unknown>;
  readonly environment?: string;
}

export class FireweaveLocalAdapter implements BackendAdapter {
  /**
   * Not `inmemory` — that name belongs to {@link InMemoryAdapter}, the fixture
   * adapter conformance runs against. This is a distinct dev substrate, and
   * `capabilities.get()` should report it as such rather than impersonate one.
   */
  readonly name = 'other' as const;

  private readonly devFlags: Record<string, boolean>;
  private readonly log: (message: string) => void;
  private readonly targets = new Map<string, LocalRegisteredTarget>();
  private closed = false;

  constructor(options: FireweaveLocalAdapterOptions = {}) {
    this.devFlags = { ...(options.devFlags ?? {}) };
    this.log = options.log ?? ((m) => console.info(m));
  }

  async initialize(_signal?: AbortSignal): Promise<void> {
    // Nothing to connect to. Kept async to satisfy the port.
  }

  /**
   * A `devFlags` hit reports `enabled: true` alongside `reason: 'STATIC'`.
   * Reporting `enabled: false` for an override of `false` would make the
   * runtime label the decision `DISABLED` (runtime.ts, reason resolution),
   * which means "the control point exists but is switched off upstream" — not
   * what a local override expresses.
   *
   * `flagType: 'boolean'` is declared honestly. Reading an overridden key as a
   * string or number therefore yields TYPE_MISMATCH rather than silently
   * handing back the default: `devFlags` is `Record<string, boolean>`, so such
   * a read is a genuine call-site mistake and is better surfaced than hidden.
   */
  async resolve(
    flagKey: string,
    _context: CanonicalContext,
    _options?: ResolveOptions,
  ): Promise<AdapterResolution> {
    const override = this.devFlags[flagKey];
    if (override === undefined) return { found: false };
    return {
      found: true,
      enabled: true,
      value: override,
      variant: override ? 'on' : 'off',
      reason: 'STATIC',
      flagType: 'boolean',
    };
  }

  /**
   * Records the target in-process and traces it, rather than reporting
   * `UnsupportedCapability`.
   *
   * The capability previously reported Unsupported so that a dev harness could
   * not *silently* look registered — the failure being guarded against is a
   * developer believing their targeting works because nothing objected. A
   * recorded target plus an explicit `[fireweave:local]` line preserves that
   * guarantee by a different route: nothing is silent, and local dev can now
   * exercise targeting rules offline instead of only in production.
   *
   * The trace names the mode, so a line appearing in a production log is
   * itself the signal that something booted in local mode by mistake.
   *
   * No network call is made and nothing reaches fw-server.
   */
  async registerTarget(
    targetingKey: string,
    options: RegisterTargetOptions = {},
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
        `${JSON.stringify(properties)} — recorded in-process, NOT sent to fw-server`,
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
      // No exposure sink exists locally; claiming otherwise would make
      // capabilities.get() advertise emission that silently goes nowhere.
      exposureEmission: false,
      sideEffectFreeReads: true,
      groupAnalytics: false,
    };
  }
}
