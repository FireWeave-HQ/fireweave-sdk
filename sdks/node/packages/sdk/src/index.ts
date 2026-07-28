/**
 * @fireweaveai/sdk — Fireweave OpenFeature provider + client for Node servers.
 * Public API per docs/architecture.md §6.
 *
 * Production default: {@link FireweaveRemoteAdapter} (FW key → fw-server).
 * InMemoryAdapter for offline/tests. PostHogAdapter (advanced/direct) lives
 * behind the "./posthog" subpath so the main entrypoint never depends on
 * posthog-node (vendor types never leak; verified by test).
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
  ResolveOptions,
} from './adapter.js';

export { InMemoryAdapter } from './adapters/inmemory.js';
export type { InMemoryAdapterOptions, InMemoryFlagDefinition, InMemoryFault } from './adapters/inmemory.js';

export { FireweaveRemoteAdapter } from './adapters/remote.js';
export type { FireweaveRemoteAdapterOptions } from './adapters/remote.js';

export { DEFAULT_ALLOWED_HOSTS, assertHostAllowed, isLoopbackHostname } from './hosts.js';

export { FireweaveRuntime, stableStringify, DEFAULT_SHUTDOWN_TIMEOUT_MS } from './runtime.js';
export type { FireweaveRuntimeConfig, EvaluateOptions, ExpectedFlagType } from './runtime.js';

export { FireweaveProvider } from './provider.js';
export type { FireweaveProviderOptions } from './provider.js';

export { FireweaveClient, DEFAULT_SIGNAL_ATTRIBUTE_ALLOWLIST } from './client.js';
export type {
  FireweaveClientOptions,
  ExtensionResult,
  ReleaseResult,
  ExposureResult,
  SignalResult,
  TelemetryPolicy,
} from './client.js';
