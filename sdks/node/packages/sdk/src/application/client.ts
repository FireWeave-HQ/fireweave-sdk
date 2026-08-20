/**
 * FireweaveClient — control-point evaluation and target registration
 * (spec/control-points.md): the only two v1 capabilities. Facade methods
 * degrade instead of throwing.
 */
import { FireweaveError, type FireweaveErrorKind } from '../domain/errors.js';
import type { EvaluateOptions, ExpectedFlagType, FireweaveRuntime } from './runtime.js';
import type { ContextInput } from '../domain/context.js';
import type { RegisterTargetOptions, RegisterTargetResult } from './ports.js';
import type { Decision, JsonValue } from '../domain/types.js';

export interface ExtensionResult {
  ok: boolean;
  errorKind?: FireweaveErrorKind;
  errorCode?: string;
  errorMessage?: string;
  degraded?: boolean;
}

const failure = (err: FireweaveError, degraded = false): ExtensionResult => ({
  ok: false,
  errorKind: err.kind,
  errorCode: err.openFeatureErrorCode,
  errorMessage: err.message,
  ...(degraded ? { degraded: true } : {}),
});

/**
 * Lifecycle gate for extension calls (ruling 17, Go/Java model; fixture
 * ext-lifecycle-gating): READY/STALE proceed; post-shutdown degrades
 * AlreadyClosed; pre-ready degrades UnsupportedCapability. Gated methods never
 * throw — failures come back as structured, degraded results.
 */
const lifecycleGate = (runtime: FireweaveRuntime): FireweaveError | undefined => {
  switch (runtime.getState()) {
    case 'READY':
    case 'STALE':
      return undefined;
    case 'SHUTDOWN':
      return new FireweaveError('AlreadyClosed');
    default:
      return new FireweaveError('UnsupportedCapability');
  }
};

/**
 * Control-point evaluation on the public client surface (ruling 16):
 * Decision-returning evaluation without reaching into the runtime. Never throws
 * — errors surface as ERROR decisions, exactly like the OpenFeature path.
 *
 * "Control point" is the Fireweave product noun (ADR-0007). The per-call
 * parameter stays `flagKey`, because that is the name fixed by the OpenFeature
 * spec, by `spec/decision.schema.json`, and by the `/v1/flags/evaluate` wire
 * contract shared with the Python, Go, and Java SDKs.
 */
export class ControlPointsApi {
  private readonly runtime: FireweaveRuntime;

  constructor(runtime: FireweaveRuntime) {
    this.runtime = runtime;
  }

  /** Evaluate a flag to a canonical Decision (detailed evaluation). */
  evaluate(
    flagKey: string,
    expectedType: ExpectedFlagType,
    defaultValue: JsonValue,
    context?: ContextInput,
    options?: EvaluateOptions,
  ): Promise<Decision> {
    return this.runtime.evaluate(flagKey, expectedType, defaultValue, context, options ?? {});
  }

  async getBooleanValue(flagKey: string, defaultValue: boolean, context?: ContextInput): Promise<boolean> {
    const decision = await this.evaluate(flagKey, 'boolean', defaultValue, context);
    return decision.value as boolean;
  }

  async getStringValue(flagKey: string, defaultValue: string, context?: ContextInput): Promise<string> {
    const decision = await this.evaluate(flagKey, 'string', defaultValue, context);
    return decision.value as string;
  }

  async getNumberValue(flagKey: string, defaultValue: number, context?: ContextInput): Promise<number> {
    const decision = await this.evaluate(flagKey, 'number', defaultValue, context);
    return decision.value as number;
  }

  async getObjectValue(flagKey: string, defaultValue: JsonValue, context?: ContextInput): Promise<JsonValue> {
    const decision = await this.evaluate(flagKey, 'object', defaultValue, context);
    return decision.value;
  }

  /**
   * Detailed reads — the whole {@link Decision} rather than just its value.
   *
   * Same arguments as the `*Value` pair above, so a caller upgrades from one to
   * the other without restructuring the call. Required by
   * `spec/control-points.md`; before ADR-0010 the only route to `reason`,
   * `variant` or `error` was the OpenFeature provider's `resolve*Evaluation`,
   * so detailed evaluation was unreachable without installing OpenFeature.
   */
  getBooleanDetails(flagKey: string, defaultValue: boolean, context?: ContextInput): Promise<Decision> {
    return this.evaluate(flagKey, 'boolean', defaultValue, context);
  }

  getStringDetails(flagKey: string, defaultValue: string, context?: ContextInput): Promise<Decision> {
    return this.evaluate(flagKey, 'string', defaultValue, context);
  }

  getNumberDetails(flagKey: string, defaultValue: number, context?: ContextInput): Promise<Decision> {
    return this.evaluate(flagKey, 'number', defaultValue, context);
  }

  getObjectDetails(flagKey: string, defaultValue: JsonValue, context?: ContextInput): Promise<Decision> {
    return this.evaluate(flagKey, 'object', defaultValue, context);
  }
}

/**
 * Names invokeCapability will dispatch instead of degrading with
 * UnsupportedCapability. Empty in v1: releases, exposures, signals,
 * capabilities discovery, and guardrails are all out of scope
 * (spec/control-points.md) and MUST NOT be exposed, so a cut namespace's
 * capability string resolves exactly like any other unknown string.
 */
const SUPPORTED_CAPABILITIES: readonly string[] = Object.freeze([]);

export interface FireweaveClientOptions {}

/**
 * One notice per process. A per-call warning on a server SDK becomes log
 * spam at request volume, which is how deprecation notices get suppressed
 * wholesale and then ignored. Unconditional (no env gate): the SDK reads no
 * environment variables (spec/modes.md "The SDK reads no environment
 * variables", unscoped — controller ruling, Task 4 fix round).
 */
let deprecationNoticeEmitted = false;

function noteDeprecatedFlagsAlias(): void {
  if (deprecationNoticeEmitted) return;
  deprecationNoticeEmitted = true;
  console.warn(
    '[fireweave] client.flags has been renamed to client.controlPoints. ' +
      'The old name remains fully supported — no migration is required.',
  );
}

export class FireweaveClient {
  readonly runtime: FireweaveRuntime;
  readonly controlPoints: ControlPointsApi;

  /**
   * Control-point evaluation under its former name.
   *
   * @deprecated Renamed to {@link FireweaveClient.controlPoints} (ADR-0007).
   * Identical and fully supported — `client.flags === client.controlPoints`, so
   * no migration is required and none is planned for v3. Logs one notice per
   * process the first time this getter is used.
   */
  get flags(): ControlPointsApi {
    noteDeprecatedFlagsAlias();
    return this.controlPoints;
  }

  constructor(runtime: FireweaveRuntime, _options: FireweaveClientOptions = {}) {
    this.runtime = runtime;
    this.controlPoints = new ControlPointsApi(runtime);
  }

  /**
   * Register durable targeting facts for a target (spec/modes.md).
   *
   * Resolves `{ ok: false }` rather than throwing: this runs in sign-in paths,
   * where a targeting concern must not break authentication. A careful caller
   * logs a false — a silently unregistered target is how targeting rules end
   * up matching nobody.
   *
   * In local mode this records in-process and traces the call; nothing reaches
   * fw-server. See `FireweaveLocalAdapter.registerTarget`.
   */
  registerTarget(
    targetingKey: string,
    options: RegisterTargetOptions = {},
  ): Promise<RegisterTargetResult> {
    return this.runtime.registerTarget(targetingKey, options);
  }

  /**
   * Dynamic capability dispatch. Unknown capabilities — currently all of
   * them, v1's SUPPORTED_CAPABILITIES is empty — degrade with
   * UnsupportedCapability, never throw (fixture
   * ext-unsupported-capability-degrade). Any future capability listed in
   * SUPPORTED_CAPABILITIES is lifecycle-gated the same way (ruling 17).
   */
  invokeCapability(capability: string, _args?: Record<string, JsonValue>): ExtensionResult {
    if (!SUPPORTED_CAPABILITIES.includes(capability)) {
      return failure(new FireweaveError('UnsupportedCapability'), true);
    }
    if (capability !== 'capabilities.get') {
      const gateError = lifecycleGate(this.runtime);
      if (gateError !== undefined) return failure(gateError, true);
    }
    return { ok: true };
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    await this.runtime.initialize(signal);
  }

  async shutdown(): Promise<void> {
    await this.runtime.shutdown();
  }
}
