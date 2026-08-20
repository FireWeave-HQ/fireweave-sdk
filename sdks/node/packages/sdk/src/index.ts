/**
 * @fireweaveai/sdk — Fireweave release-engineering SDK for server runtimes
 * (Node, Bun, Deno). Public API per docs/architecture.md §6.
 *
 * Exactly two v1 capabilities (spec/control-points.md): control points and
 * target registration.
 *
 * Production default: {@link FireweaveRemoteAdapter} (Fireweave project key →
 * fw-server). {@link InMemoryAdapter} for offline work and tests. The backend
 * fw-server forwards to is fw-server's concern — no vendor SDK, key, or host
 * appears in the application process (ADR-0005, ADR-0006).
 */
export { FireweaveError, ERROR_TAXONOMY, redactSecrets, isFireweaveError } from './domain/errors.js';
export type { FireweaveErrorKind, OpenFeatureErrorCode, ErrorKindSpec } from './domain/errors.js';

export type {
  JsonValue,
  Decision,
  DecisionReason,
  CanonicalContext,
  LifecycleState,
  Signal,
  SignalKind,
  ReleaseContext,
  ReleaseState,
  ReleaseStatus,
  Exposure,
  Capabilities,
  FlagValueType,
} from './domain/types.js';

export {
  DEFAULT_CONTEXT_LIMITS,
  DEFAULT_RESERVED_ATTRIBUTE_KEYS,
  ALLOWED_FIREWEAVE_CONTEXT_KEYS,
  mergeContexts,
  normalizeContextInput,
  resolvedContextView,
} from './domain/context.js';
export type { ContextInput, ContextLimits, ContextPolicy } from './domain/context.js';

export {
  canonicalizeContext,
  validateControlPointKey,
  validateDefaultValue,
  validateContext,
  validateTargetingKey,
  validateInitOptions,
} from './domain/validation.js';
export type { Validated } from './domain/validation.js';

export type {
  BackendAdapter,
  AdapterResolution,
  AdapterRuntimeFeatures,
  RegisterTargetOptions,
  RegisterTargetResult,
  ResolveOptions,
} from './application/ports.js';
export type { TargetKind } from './domain/target.js';

export { InMemoryAdapter } from './infrastructure/adapters/inmemory.js';
export type { InMemoryAdapterOptions, InMemoryFlagDefinition, InMemoryFault } from './infrastructure/adapters/inmemory.js';

export { FireweaveRemoteAdapter } from './infrastructure/adapters/remote.js';
export type { FireweaveRemoteAdapterOptions } from './infrastructure/adapters/remote.js';

export { FireweaveLocalAdapter } from './infrastructure/adapters/local.js';
export type { FireweaveLocalAdapterOptions } from './infrastructure/adapters/local.js';


export { DEFAULT_ALLOWED_HOSTS, assertHostAllowed, isLoopbackHostname } from './infrastructure/hosts.js';

export { FireweaveRuntime, stableStringify, DEFAULT_SHUTDOWN_TIMEOUT_MS } from './application/runtime.js';
export type { FireweaveRuntimeConfig, EvaluateOptions, ExpectedFlagType } from './application/runtime.js';


export { FireweaveClient } from './application/client.js';
export type { ControlPointsApi, FireweaveClientOptions } from './application/client.js';

export { initFireweave } from './application/mode.js';
export type {
  InitFireweaveOptions,
  InitFireweaveLocalOptions,
  InitFireweaveRemoteOptions,
} from './application/mode.js';
