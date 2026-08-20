/**
 * FireweaveWebClient — the Fireweave-native surface, mirroring the server
 * SDK's `FireweaveClient` namespace for namespace (ADR-0003: extensions live
 * beside the OpenFeature client, never inside it).
 *
 * Scope of v1 (spec/control-points.md "Scope of v1"): exactly two
 * capabilities — control points and target registration. Releases,
 * exposures, signals, capabilities discovery and guardrails are out of v1;
 * this client MUST NOT expose them (conformance/surface/control-points.surface.json
 * "mustNotExpose"). The dynamic `invokeCapability` dispatcher and the
 * deprecated `flags` alias survive unchanged.
 *
 * One divergence from the server SDK, and it is intentional: `controlPoints.*`
 * is SYNCHRONOUS here and promise-returning on the server. That follows from
 * the OpenFeature web contract — browser reads happen in render paths — and
 * is recorded in docs/compatibility.md as a surface difference rather than a
 * gap.
 */
import { FireweaveError } from '../domain/errors.js';
import type { ContextInput } from '../domain/context.js';
import type { FireweaveWebRuntime, ExpectedFlagType } from './runtime.js';
import type { Decision, JsonValue } from '../domain/types.js';
import type { RegisterTargetOptions, RegisterTargetResult } from './ports.js';

export interface ExtensionResult {
  readonly ok: boolean;
  readonly error?: FireweaveError;
  readonly degraded?: boolean;
}

function failure(error: FireweaveError, degraded = false): ExtensionResult {
  return degraded ? { ok: false, error, degraded: true } : { ok: false, error };
}

/**
 * Lifecycle gate for extension calls. Kept for forward compatibility with
 * `invokeCapability` (ruling 17, Go/Java model) even though v1's
 * SUPPORTED_CAPABILITIES is empty and therefore never reaches it today — a
 * future capability re-added to the allowlist is gated the same way without
 * this function needing to be reinvented.
 */
function lifecycleGate(runtime: FireweaveWebRuntime): FireweaveError | undefined {
  const state = runtime.getState();
  if (state === 'SHUTDOWN') return new FireweaveError('AlreadyClosed');
  if (state === 'UNINITIALIZED' || state === 'INITIALIZING') return new FireweaveError('NotReady');
  return undefined;
}

/**
 * Reserved for cross-language surface parity
 * (conformance/surface/control-points.surface.json pins `evaluate(key, type,
 * default, context?, options?)` across every language). Currently INERT on
 * web — accepted and typed, nothing reads it.
 *
 * Node's `EvaluateOptions` carries `signal` (abort an in-flight network
 * call), `includePayload` (attach raw flag payload metadata), and
 * `sendExposure` (opt into exposure emission for this one call). None of
 * those map cleanly onto web's contract: `evaluate` here is a SYNCHRONOUS
 * read of an already-prefetched cache (ADR-0009), so there is no in-flight
 * I/O to abort at read time, and exposure emission is a constructor-level
 * opt-in (`FireweaveWebRuntimeConfig.sendExposure`) rather than a per-call
 * one. The parameter exists so this method's ARITY matches the descriptor
 * every language is pinned to, not because it does anything yet.
 */
export interface EvaluateOptions {}

/**
 * Control-point evaluation on the public client surface — decision-returning,
 * without reaching into the runtime. Never throws; errors surface as ERROR
 * decisions, exactly like the OpenFeature path.
 */
export class WebControlPointsApi {
  private readonly runtime: FireweaveWebRuntime;

  constructor(runtime: FireweaveWebRuntime) {
    this.runtime = runtime;
  }

  evaluate(
    flagKey: string,
    expectedType: ExpectedFlagType,
    defaultValue: JsonValue,
    context?: ContextInput,
    _options?: EvaluateOptions
  ): Decision {
    return this.runtime.evaluateSync(flagKey, expectedType, defaultValue, context);
  }

  getBooleanValue(flagKey: string, defaultValue: boolean, context?: ContextInput): boolean {
    return this.evaluate(flagKey, 'boolean', defaultValue, context).value as boolean;
  }

  getStringValue(flagKey: string, defaultValue: string, context?: ContextInput): string {
    return this.evaluate(flagKey, 'string', defaultValue, context).value as string;
  }

  getNumberValue(flagKey: string, defaultValue: number, context?: ContextInput): number {
    return this.evaluate(flagKey, 'number', defaultValue, context).value as number;
  }

  getObjectValue(flagKey: string, defaultValue: JsonValue, context?: ContextInput): JsonValue {
    return this.evaluate(flagKey, 'object', defaultValue, context).value;
  }

  /**
   * Detailed reads — the whole {@link Decision} rather than just its value.
   *
   * Same arguments as the `*Value` pair above, so a caller upgrades from one
   * to the other without restructuring the call (spec/control-points.md "The
   * nine methods"). SYNCHRONOUS like every other read here (ADR-0009).
   */
  getBooleanDetails(flagKey: string, defaultValue: boolean, context?: ContextInput): Decision {
    return this.evaluate(flagKey, 'boolean', defaultValue, context);
  }

  getStringDetails(flagKey: string, defaultValue: string, context?: ContextInput): Decision {
    return this.evaluate(flagKey, 'string', defaultValue, context);
  }

  getNumberDetails(flagKey: string, defaultValue: number, context?: ContextInput): Decision {
    return this.evaluate(flagKey, 'number', defaultValue, context);
  }

  getObjectDetails(flagKey: string, defaultValue: JsonValue, context?: ContextInput): Decision {
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

export interface FireweaveWebClientOptions {}

/**
 * One notice per process. Unconditional (no env gate): the SDK reads no
 * environment variables (ADR-0009 security rule 3).
 */
let deprecationNoticeEmitted = false;

function noteDeprecatedFlagsAlias(): void {
  if (deprecationNoticeEmitted) return;
  deprecationNoticeEmitted = true;
  console.warn(
    '[fireweave] client.flags has been renamed to client.controlPoints. ' +
      'The old name remains fully supported — no migration is required.'
  );
}

export class FireweaveWebClient {
  readonly runtime: FireweaveWebRuntime;
  readonly controlPoints: WebControlPointsApi;

  /**
   * Control-point evaluation under its former name.
   *
   * @deprecated Renamed to {@link FireweaveWebClient.controlPoints}
   * (ADR-0007). Identical and fully supported —
   * `client.flags === client.controlPoints` — so no migration is required.
   * Logs one notice per process the first time this getter is used.
   */
  get flags(): WebControlPointsApi {
    noteDeprecatedFlagsAlias();
    return this.controlPoints;
  }

  constructor(runtime: FireweaveWebRuntime, _options: FireweaveWebClientOptions = {}) {
    this.runtime = runtime;
    this.controlPoints = new WebControlPointsApi(runtime);
  }

  /**
   * Dynamic capability dispatch. Unknown capabilities — currently all of
   * them, v1's SUPPORTED_CAPABILITIES is empty — degrade with
   * UnsupportedCapability, never throw. Any future capability listed in
   * SUPPORTED_CAPABILITIES is lifecycle-gated the same way (ruling 17).
   */
  invokeCapability(capability: string, _args?: Record<string, JsonValue>): ExtensionResult {
    if (!SUPPORTED_CAPABILITIES.includes(capability)) {
      return failure(new FireweaveError('UnsupportedCapability'), true);
    }
    const gate = lifecycleGate(this.runtime);
    if (gate !== undefined) return failure(gate, true);
    return { ok: true };
  }

  initialize(context?: ContextInput): Promise<void> {
    return this.runtime.initialize(context);
  }

  /**
   * Register durable targeting facts for a target (spec/modes.md).
   *
   * Resolves rather than throwing: this runs in sign-in paths, where a
   * targeting concern must not break authentication. In local mode this
   * records in-process and traces the call; nothing reaches fw-server (see
   * `FireweaveLocalWebAdapter.registerTarget`).
   */
  registerTarget(
    targetingKey: string,
    options: RegisterTargetOptions = {}
  ): Promise<RegisterTargetResult> {
    return this.runtime.registerTarget(targetingKey, options);
  }

  /**
   * Sign-in hook: register the user's durable targeting properties, then
   * re-prefetch under that id so percentage ramps bucket on a stable key.
   *
   * Two kinds of property feed a rule and both are needed — DURABLE ones
   * registered here, and PER-REQUEST ones carried in the evaluation context. A
   * rule targeting a property that is never registered AND never sent matches
   * nobody, silently.
   */
  async identify(
    targetingKey: string,
    options: RegisterTargetOptions = {}
  ): Promise<RegisterTargetResult> {
    const result = await this.runtime.registerTarget(targetingKey, options);
    await this.runtime.setContext({ targetingKey });
    return result;
  }

  async shutdown(): Promise<void> {
    await this.runtime.shutdown();
  }
}
