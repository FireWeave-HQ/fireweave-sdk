/**
 * @fireweaveai/web-sdk — Fireweave control points for the browser (ADR-0009).
 *
 * Remote-only and secret-free by construction: it never evaluates locally, has
 * no vendor SDK dependency, reads no environment, and rejects vendor/secret key
 * shapes at the door. Credentials are passed in explicitly by the embedding app.
 *
 * ```ts
 * import { initFireweave } from '@fireweaveai/web-sdk';
 *
 * const fw = await initFireweave({
 *   mode: 'remote',
 *   apiKey,
 *   apiUrl,
 *   context: { targetingKey: 'anonymous' },
 * });
 *
 * // Reads are SYNCHRONOUS — no await, safe inside render.
 * const on = fw.controlPoints.getBooleanValue('new-checkout', false);
 * ```
 *
 * `src/` is layered domain/ · application/ · infrastructure/
 * (test/unit/architecture-layers.test.ts guards the boundary): `domain/` is
 * pure data + validation with no outward imports; `application/` wires
 * domain types into the runtime/client surface, with `mode.ts` as the sole
 * composition root allowed to reach into `infrastructure/`; `infrastructure/`
 * holds the concrete adapters and the host allowlist.
 */
export { FireweaveError, ERROR_TAXONOMY, isFireweaveError } from './domain/errors.js';
export type { FireweaveErrorKind, FireweaveErrorOptions, OpenFeatureErrorCode, ErrorKindSpec } from './domain/errors.js';

export type {
  JsonValue,
  FlagValueType,
  Decision,
  DecisionReason,
  CanonicalContext,
  LifecycleState,
  Signal,
  SignalKind,
  Exposure,
  ReleaseContext,
  ReleaseState,
  Capabilities,
} from './domain/types.js';

export { DEFAULT_CONTEXT_LIMITS, DEFAULT_RESERVED_ATTRIBUTE_KEYS, mergeContexts } from './domain/context.js';
export type { ContextInput, ContextLimits, ContextPolicy } from './domain/context.js';

export {
  canonicalizeContext,
  matchesExpectedType,
  validateContext,
  validateControlPointKey,
  validateDefaultValue,
  validateTargetingKey,
  validateInitOptions,
} from './domain/validation.js';
export type { Validated } from './domain/validation.js';

export type { TargetKind } from './domain/target.js';

export { DEFAULT_ALLOWED_HOSTS, assertHostAllowed, assertNotSecretKey, isLoopbackHostname } from './infrastructure/hosts.js';

export type {
  WebBackendAdapter,
  AdapterResolution,
  AdapterRuntimeFeatures,
  PrefetchOptions,
  PrefetchResult,
  RegisterTargetOptions,
  RegisterTargetResult,
} from './application/ports.js';

export { FireweaveRemoteWebAdapter } from './infrastructure/adapters/remote.js';
export type { FireweaveRemoteWebAdapterOptions, FireweaveFetchLike } from './infrastructure/adapters/remote.js';

export { InMemoryWebAdapter } from './infrastructure/adapters/inmemory.js';
export type { InMemoryWebAdapterOptions, InMemoryFlagDefinition, InMemoryFault } from './infrastructure/adapters/inmemory.js';

export { FireweaveLocalWebAdapter } from './infrastructure/adapters/local.js';
export type { FireweaveLocalWebAdapterOptions, LocalRegisteredTarget } from './infrastructure/adapters/local.js';

export { FireweaveWebRuntime, DEFAULT_FLAGS_READY_TIMEOUT_MS } from './application/runtime.js';
export type { FireweaveWebRuntimeConfig, ExpectedFlagType } from './application/runtime.js';

export { FireweaveWebClient, WebControlPointsApi } from './application/client.js';
export type { FireweaveWebClientOptions, ExtensionResult, EvaluateOptions } from './application/client.js';

export { initFireweave } from './application/mode.js';
export type { InitFireweaveOptions, InitFireweaveLocalOptions, InitFireweaveRemoteOptions } from './application/mode.js';
