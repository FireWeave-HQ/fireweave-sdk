/**
 * `makeFireweaveLocalProvider()` — the OpenFeature provider a scaffolded
 * harness binds on its DEV branch.
 *
 * It wires {@link FireweaveLocalAdapter} through the ordinary
 * {@link FireweaveRuntime} + {@link FireweaveProvider} stack, then applies one
 * narrow rewrite on the way out.
 *
 * ## Why the rewrite exists
 *
 * The runtime turns an adapter miss into an ERROR decision carrying
 * `FLAG_NOT_FOUND`. That is correct for a real backend — asking for a control
 * point the server has never heard of is a genuine misconfiguration — and it
 * is pinned across all four language SDKs by
 * `contracts/evaluation/eval-missing-flag-default.json`, so it is a ratified
 * contract rather than an implementation detail.
 *
 * On the dev substrate the same signal means the opposite. "Not configured
 * locally" is the *normal* state of nearly every control point on a laptop:
 * the harness scaffolds both branches up front, and call sites default to
 * `false` until a rollout ramps them. Surfacing that as an error would make
 * every dev read an error resolution — which pollutes OpenFeature error hooks,
 * inflates flag-error telemetry for anyone running the OTel flag hooks, and
 * buries the errors that do matter.
 *
 * So exactly one outcome is rewritten: `FLAG_NOT_FOUND` becomes a clean
 * `DEFAULT` resolution carrying the caller's own default value. Everything
 * else — `PROVIDER_NOT_READY`, `INVALID_CONTEXT`, `TYPE_MISMATCH`,
 * `PROVIDER_FATAL` — passes through untouched, because each of those is a real
 * defect in dev too, and a dev provider that hides them is worse than no dev
 * provider.
 *
 * ## Observability
 *
 * Two ways to see what happened, mirroring the pair the harness already
 * expects: humans read the optional `echo` line; tests read
 * {@link getFwLocalCaptures}. Captures are recorded here rather than in the
 * adapter so each entry reflects what the caller actually observed — including
 * the rewritten `DEFAULT` reason, which the adapter never sees.
 */
import {
  ErrorCode,
  StandardResolutionReasons,
  type EvaluationContext,
  type JsonValue,
  type Provider,
  type ProviderMetadata,
  type ResolutionDetails,
} from '@openfeature/server-sdk';
import { FireweaveProvider } from './provider.js';
import { FireweaveRuntime } from './runtime.js';
import { FireweaveLocalAdapter } from './adapters/local.js';

export interface FwLocalCapture {
  readonly flagKey: string;
  readonly type: 'boolean' | 'string' | 'number' | 'object';
  readonly value: unknown;
  readonly reason: string;
  readonly ts: number;
}

let captures: FwLocalCapture[] = [];

/** Every evaluation observed through a local provider in this process. */
export function getFwLocalCaptures(): readonly FwLocalCapture[] {
  return captures;
}

/** Clear the capture buffer (call between tests). */
export function resetFwLocalCaptures(): void {
  captures = [];
}

export interface FireweaveLocalProviderOptions {
  /**
   * Per-key boolean overrides — the only supported way to turn a control point
   * ON (or force it OFF) locally. Absent keys resolve to the call-site default.
   */
  readonly devFlags?: Record<string, boolean>;
  /** Print one line per evaluation to the console. Default `false`. */
  readonly echo?: boolean;
  /** Injected clock, so capture timestamps are deterministic under test. */
  readonly now?: () => number;
}

class FireweaveLocalProvider implements Provider {
  readonly metadata: ProviderMetadata = Object.freeze({ name: 'fireweave-local' });
  readonly runsOn = 'server' as const;

  private readonly inner: FireweaveProvider;
  private readonly echo: boolean;
  private readonly now: () => number;

  constructor(options: FireweaveLocalProviderOptions = {}) {
    const adapterOptions =
      options.devFlags !== undefined ? { devFlags: options.devFlags } : {};
    this.inner = new FireweaveProvider(
      new FireweaveRuntime(new FireweaveLocalAdapter(adapterOptions)),
      // Eager readiness: a laptop has nothing to connect to, so there is no
      // reason to serve NotReady decisions during a startup window that does
      // not exist.
      { lazyReady: false },
    );
    this.echo = options.echo ?? false;
    this.now = options.now ?? (() => Date.now());
  }

  initialize(context?: EvaluationContext): Promise<void> {
    return this.inner.initialize(context);
  }

  onClose(): Promise<void> {
    return this.inner.onClose();
  }

  onContextChange(oldContext: EvaluationContext, newContext: EvaluationContext): Promise<void> {
    return this.inner.onContextChange(oldContext, newContext);
  }

  async resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<boolean>> {
    return this.finish(
      'boolean',
      flagKey,
      defaultValue,
      await this.inner.resolveBooleanEvaluation(flagKey, defaultValue, context),
    );
  }

  async resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<string>> {
    return this.finish(
      'string',
      flagKey,
      defaultValue,
      await this.inner.resolveStringEvaluation(flagKey, defaultValue, context),
    );
  }

  async resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<number>> {
    return this.finish(
      'number',
      flagKey,
      defaultValue,
      await this.inner.resolveNumberEvaluation(flagKey, defaultValue, context),
    );
  }

  async resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<T>> {
    return this.finish(
      'object',
      flagKey,
      defaultValue,
      await this.inner.resolveObjectEvaluation<T>(flagKey, defaultValue, context),
    );
  }

  /** Apply the not-found rewrite, then record what the caller will see. */
  private finish<T>(
    type: FwLocalCapture['type'],
    flagKey: string,
    defaultValue: T,
    details: ResolutionDetails<T>,
  ): ResolutionDetails<T> {
    const resolved =
      details.errorCode === ErrorCode.FLAG_NOT_FOUND
        ? {
            value: defaultValue,
            variant: 'default',
            reason: StandardResolutionReasons.DEFAULT,
          }
        : details;

    this.record(type, flagKey, resolved.value, resolved.reason ?? StandardResolutionReasons.UNKNOWN);
    return resolved;
  }

  private record(
    type: FwLocalCapture['type'],
    flagKey: string,
    value: unknown,
    reason: string,
  ): void {
    captures.push({ flagKey, type, value, reason, ts: this.now() });
    if (this.echo) {
      // eslint-disable-next-line no-console
      console.log(`[fw-local] ${type} ${flagKey} = ${JSON.stringify(value)} (${reason})`);
    }
  }
}

/**
 * Build the dev-branch OpenFeature provider.
 *
 * ```ts
 * // fw-providers.ts (scaffolded by /fireweave:initialise)
 * export function makeDevProvider(): Provider {
 *   return makeFireweaveLocalProvider({
 *     echo: true,
 *     devFlags: { 'my-feature': true },   // dogfood one control point ON
 *   });
 * }
 * ```
 */
export function makeFireweaveLocalProvider(
  options: FireweaveLocalProviderOptions = {},
): Provider {
  return new FireweaveLocalProvider(options);
}
