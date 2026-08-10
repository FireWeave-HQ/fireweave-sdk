/**
 * OpenFeature web provider — the SYNCHRONOUS surface.
 *
 * `resolve*Evaluation` returns `ResolutionDetails` directly, never a Promise.
 * That is the load-bearing web invariant: browser call sites read control
 * points without `await`, inside render paths where awaiting is not an option.
 * Everything asynchronous happens in `initialize` / `onContextChange`, which
 * the OpenFeature web SDK is explicitly allowed to await.
 *
 * Per ADR-0003 the provider is a mapping layer only: OpenFeature types in,
 * runtime decisions out. It owns error-code translation and nothing else.
 */
import {
  ErrorCode,
  OpenFeatureEventEmitter,
  ProviderEvents,
  type EvaluationContext,
  type JsonValue as OFJsonValue,
  type Paradigm,
  type Provider,
  type ProviderMetadata,
  type ResolutionDetails,
} from '@openfeature/web-sdk';
import type { ContextInput } from './context.js';
import type { FireweaveWebRuntime, ExpectedFlagType } from './runtime.js';
import type { Decision, JsonValue } from './types.js';

const ERROR_CODE_MAP: Readonly<Record<string, ErrorCode>> = Object.freeze({
  PROVIDER_NOT_READY: ErrorCode.PROVIDER_NOT_READY,
  PROVIDER_FATAL: ErrorCode.PROVIDER_FATAL,
  FLAG_NOT_FOUND: ErrorCode.FLAG_NOT_FOUND,
  PARSE_ERROR: ErrorCode.PARSE_ERROR,
  TYPE_MISMATCH: ErrorCode.TYPE_MISMATCH,
  TARGETING_KEY_MISSING: ErrorCode.TARGETING_KEY_MISSING,
  INVALID_CONTEXT: ErrorCode.INVALID_CONTEXT,
  GENERAL: ErrorCode.GENERAL,
});

function toResolutionDetails<T>(decision: Decision, defaultValue: T): ResolutionDetails<T> {
  if (decision.errorCode !== undefined) {
    const details: ResolutionDetails<T> = {
      value: defaultValue,
      reason: decision.reason,
      errorCode: ERROR_CODE_MAP[decision.errorCode] ?? ErrorCode.GENERAL,
      flagMetadata: { ...decision.metadata },
    };
    return decision.errorMessage !== undefined
      ? { ...details, errorMessage: decision.errorMessage }
      : details;
  }
  const details: ResolutionDetails<T> = {
    value: decision.value as unknown as T,
    reason: decision.reason,
    flagMetadata: { ...decision.metadata },
  };
  return decision.variant !== undefined ? { ...details, variant: decision.variant } : details;
}

export interface FireweaveWebProviderOptions {
  /** Provider name reported to OpenFeature. Defaults to `fireweave-web`. */
  readonly name?: string;
}

export class FireweaveWebProvider implements Provider {
  readonly metadata: ProviderMetadata;
  readonly runsOn: Paradigm = 'client';
  readonly events = new OpenFeatureEventEmitter();
  readonly runtime: FireweaveWebRuntime;

  constructor(runtime: FireweaveWebRuntime, options: FireweaveWebProviderOptions = {}) {
    this.runtime = runtime;
    this.metadata = Object.freeze({ name: options.name ?? 'fireweave-web' });
  }

  async initialize(context?: EvaluationContext): Promise<void> {
    await this.runtime.initialize(context as ContextInput | undefined);
    if (this.runtime.getState() === 'STALE') {
      // Surfaced, not swallowed: the app booted, but on defaults. A host that
      // cares (a kill-switch, say) can react instead of silently shipping OFF.
      this.events.emit(ProviderEvents.Stale, {
        message: 'fireweave: flag prefetch did not complete; serving defaults',
      });
    }
  }

  /**
   * The identity-change path. Emits ConfigurationChanged with only the control
   * points whose decisions actually moved, so subscribers re-render on real
   * changes rather than on every sign-in.
   */
  async onContextChange(
    _oldContext: EvaluationContext,
    newContext: EvaluationContext
  ): Promise<void> {
    const changed = await this.runtime.setContext(newContext as ContextInput);
    if (changed.length > 0) {
      this.events.emit(ProviderEvents.ConfigurationChanged, { flagsChanged: [...changed] });
    }
  }

  async onClose(): Promise<void> {
    await this.runtime.shutdown();
  }

  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext
  ): ResolutionDetails<boolean> {
    return this.resolve(flagKey, 'boolean', defaultValue, context);
  }

  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext
  ): ResolutionDetails<string> {
    return this.resolve(flagKey, 'string', defaultValue, context);
  }

  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext
  ): ResolutionDetails<number> {
    return this.resolve(flagKey, 'number', defaultValue, context);
  }

  resolveObjectEvaluation<T extends OFJsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext
  ): ResolutionDetails<T> {
    return this.resolve(flagKey, 'object', defaultValue, context);
  }

  private resolve<T>(
    flagKey: string,
    expectedType: ExpectedFlagType,
    defaultValue: T,
    context: EvaluationContext
  ): ResolutionDetails<T> {
    const decision = this.runtime.evaluateSync(
      flagKey,
      expectedType,
      defaultValue as unknown as JsonValue,
      context as ContextInput
    );
    return toResolutionDetails(decision, defaultValue);
  }
}
