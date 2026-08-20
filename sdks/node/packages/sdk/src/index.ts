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
export { FireweaveError, ERROR_TAXONOMY, redactSecrets, isFireweaveError } from './errors.js';
export type { FireweaveErrorKind, OpenFeatureErrorCode, ErrorKindSpec } from './errors.js';

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
} from './types.js';

export {
  DEFAULT_CONTEXT_LIMITS,
  DEFAULT_RESERVED_ATTRIBUTE_KEYS,
  ALLOWED_FIREWEAVE_CONTEXT_KEYS,
  mergeContexts,
  normalizeContextInput,
  canonicalizeContext,
  resolvedContextView,
} from './context.js';
export type { ContextInput, ContextLimits, ContextPolicy } from './context.js';

export type {
  BackendAdapter,
  AdapterResolution,
  AdapterRuntimeFeatures,
  RegisterTargetOptions,
  RegisterTargetResult,
  ResolveOptions,
  TargetKind,
} from './adapter.js';

export { InMemoryAdapter } from './adapters/inmemory.js';
export type { InMemoryAdapterOptions, InMemoryFlagDefinition, InMemoryFault } from './adapters/inmemory.js';

export { FireweaveRemoteAdapter } from './adapters/remote.js';
export type { FireweaveRemoteAdapterOptions } from './adapters/remote.js';

export { FireweaveLocalAdapter } from './adapters/local.js';
export type { FireweaveLocalAdapterOptions } from './adapters/local.js';


export { DEFAULT_ALLOWED_HOSTS, assertHostAllowed, isLoopbackHostname } from './hosts.js';

export { FireweaveRuntime, stableStringify, DEFAULT_SHUTDOWN_TIMEOUT_MS } from './runtime.js';
export type { FireweaveRuntimeConfig, EvaluateOptions, ExpectedFlagType } from './runtime.js';


export { FireweaveClient } from './client.js';
export type { ControlPointsApi, FireweaveClientOptions } from './client.js';
