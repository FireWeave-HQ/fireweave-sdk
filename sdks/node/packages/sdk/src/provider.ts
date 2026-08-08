/**
 * OpenFeature server provider (spec floor 0.8.0, @openfeature/server-sdk@1.22.x).
 * Thin mapping layer: OpenFeature types in, FireweaveRuntime decisions out.
 * Per ADR-0003 the provider owns targeting-key passthrough and error-code
 * translation; it never leaks backend types.
 */
import {
  ErrorCode,
  type EvaluationContext,
  type JsonValue as OFJsonValue,
  type Provider,
  type ProviderMetadata,
  type ResolutionDetails,
} from '@openfeature/server-sdk';
import { FireweaveError } from './errors.js';
import type { OpenFeatureErrorCode } from './errors.js';
import type { ContextInput } from './context.js';
import type { FireweaveRuntime, ExpectedFlagType } from './runtime.js';
import type { Decision, JsonValue } from './types.js';

const ERROR_CODE_MAP: Readonly<Record<OpenFeatureErrorCode, ErrorCode>> = Object.freeze({
  PROVIDER_NOT_READY: ErrorCode.PROVIDER_NOT_READY,
  PROVIDER_FATAL: ErrorCode.PROVIDER_FATAL,
  FLAG_NOT_FOUND: ErrorCode.FLAG_NOT_FOUND,
  PARSE_ERROR: ErrorCode.PARSE_ERROR,
  TYPE_MISMATCH: ErrorCode.TYPE_MISMATCH,
  TARGETING_KEY_MISSING: ErrorCode.TARGETING_KEY_MISSING,
  INVALID_CONTEXT: ErrorCode.INVALID_CONTEXT,
  GENERAL: ErrorCode.GENERAL,
});

function toContextInput(context: EvaluationContext): ContextInput {
  // OpenFeature contexts are flat: targetingKey + arbitrary attributes.
  return context as ContextInput;
}

function toResolutionDetails<T>(decision: Decision, defaultValue: T): ResolutionDetails<T> {
  const details: ResolutionDetails<T> = {
    value: (decision.errorCode !== undefined ? defaultValue : (decision.value as unknown as T)),
    reason: decision.reason,
    flagMetadata: { ...decision.metadata },
  };
  if (decision.variant !== undefined) details.variant = decision.variant;
  if (decision.errorCode !== undefined) {
    details.errorCode = ERROR_CODE_MAP[decision.errorCode];
    if (decision.errorMessage !== undefined) details.errorMessage = decision.errorMessage;
    // Error decisions carry the flag's default per OF spec; disabled flags carry flag value.
    details.value = defaultValue;
  } else {
    details.value = decision.value as unknown as T;
  }
  return details;
}

export interface FireweaveProviderOptions {
  /** Attach flag payloads to flagMetadata as fireweave.payload. */
  includePayload?: boolean;
  /**
   * When true, successful OF evaluations emit a Fireweave-owned exposure
   * (H-4 / ADR-0001 errata / ruling 20). Default `false` — side-effect-free
   * OF reads; opt in to arm Fireweave emission/dedup (vendor
   * `$feature_flag_called` remains suppressed — RB-2).
   */
  sendExposure?: boolean;
  /**
   * When true (default) initialize() resolves immediately and runtime readiness
   * is reflected in evaluation decisions (NotReady decisions carry fireweave
   * error metadata instead of the OF SDK short-circuiting evaluation).
   */
  lazyReady?: boolean;
}

export class FireweaveProvider implements Provider {
  readonly metadata: ProviderMetadata = Object.freeze({ name: 'fireweave' });
  readonly runsOn = 'server' as const;
  readonly runtime: FireweaveRuntime;
  private readonly options: FireweaveProviderOptions;

  constructor(runtime: FireweaveRuntime, options: FireweaveProviderOptions = {}) {
    this.runtime = runtime;
    this.options = { lazyReady: true, ...options };
  }

  async initialize(context?: EvaluationContext): Promise<void> {
    // The OF SDK always passes its API-level context here — an empty object
    // when none was set. Only adopt it when it carries data, so a global
    // context configured directly on the runtime is not clobbered.
    if (context !== undefined && Object.keys(context).length > 0) {
      this.runtime.setGlobalContext(toContextInput(context));
    }
    if (this.options.lazyReady === true) {
      // Kick off init in the background; evaluations surface NotReady decisions
      // until the runtime is READY. Swallow rejection here — state is tracked.
      void this.runtime.initialize().catch(() => undefined);
      return;
    }
    await this.runtime.initialize();
  }

  async onClose(): Promise<void> {
    await this.runtime.shutdown();
  }

  onContextChange(_oldContext: EvaluationContext, newContext: EvaluationContext): Promise<void> {
    this.runtime.setGlobalContext(toContextInput(newContext));
    return Promise.resolve();
  }

  private async resolve<T>(
    flagKey: string,
    expectedType: ExpectedFlagType,
    defaultValue: T,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<T>> {
    const evalOpts: { includePayload?: boolean; sendExposure?: boolean } = {};
    if (this.options.includePayload === true) evalOpts.includePayload = true;
    if (this.options.sendExposure === true) evalOpts.sendExposure = true;
    const decision = await this.runtime.evaluate(
      flagKey,
      expectedType,
      defaultValue as unknown as JsonValue,
      toContextInput(context),
      evalOpts,
    );
    return toResolutionDetails(decision, defaultValue);
  }

  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<boolean>> {
    return this.resolve(flagKey, 'boolean', defaultValue, context);
  }

  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<string>> {
    return this.resolve(flagKey, 'string', defaultValue, context);
  }

  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<number>> {
    return this.resolve(flagKey, 'number', defaultValue, context);
  }

  resolveObjectEvaluation<T extends OFJsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<T>> {
    return this.resolve(flagKey, 'object', defaultValue, context);
  }
}

export { FireweaveError };
