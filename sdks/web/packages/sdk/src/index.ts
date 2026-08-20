/**
 * @fireweaveai/web-sdk — Fireweave control points for the browser (ADR-0009).
 *
 * Remote-only and secret-free by construction: it never evaluates locally, has
 * no vendor SDK dependency, reads no environment, and rejects vendor/secret key
 * shapes at the door. Credentials are passed in explicitly by the embedding app.
 *
 * ```ts
 * import {
 *   FireweaveRemoteWebAdapter,
 *   FireweaveWebRuntime,
 *   FireweaveWebClient,
 * } from '@fireweaveai/web-sdk';
 *
 * const runtime = new FireweaveWebRuntime(
 *   new FireweaveRemoteWebAdapter({ apiUrl, apiKey }),
 *   { globalContext: { targetingKey: 'anonymous' } }
 * );
 * await runtime.initialize();
 * const fw = new FireweaveWebClient(runtime);
 *
 * // Reads are SYNCHRONOUS — no await, safe inside render.
 * const on = fw.controlPoints.getBooleanValue('new-checkout', false);
 * ```
 */
export {
  FireweaveError,
  ERROR_TAXONOMY,
  isFireweaveError,
} from './errors.js';
export type {
  FireweaveErrorKind,
  FireweaveErrorOptions,
  OpenFeatureErrorCode,
  ErrorKindSpec,
} from './errors.js';

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
} from './types.js';

export {
  DEFAULT_CONTEXT_LIMITS,
  DEFAULT_RESERVED_ATTRIBUTE_KEYS,
  canonicalizeContext,
  mergeContexts,
} from './context.js';
export type { ContextInput, ContextLimits } from './context.js';

export {
  DEFAULT_ALLOWED_HOSTS,
  assertHostAllowed,
  assertNotSecretKey,
  isLoopbackHostname,
} from './hosts.js';

export type {
  WebBackendAdapter,
  AdapterResolution,
  AdapterRuntimeFeatures,
  PrefetchOptions,
  PrefetchResult,
  RegisterTargetOptions,
  RegisterTargetResult,
  TargetKind,
} from './adapter.js';

export { FireweaveRemoteWebAdapter } from './adapters/remote.js';
export type {
  FireweaveRemoteWebAdapterOptions,
  FireweaveFetchLike,
} from './adapters/remote.js';

export { InMemoryWebAdapter } from './adapters/inmemory.js';
export type {
  InMemoryWebAdapterOptions,
  InMemoryFlagDefinition,
  InMemoryFault,
} from './adapters/inmemory.js';

export { FireweaveLocalWebAdapter } from './adapters/local.js';
export type { FireweaveLocalWebAdapterOptions } from './adapters/local.js';

export { FireweaveWebRuntime, DEFAULT_FLAGS_READY_TIMEOUT_MS } from './runtime.js';
export type { FireweaveWebRuntimeConfig, ExpectedFlagType } from './runtime.js';


export {
  FireweaveWebClient,
  WebControlPointsApi,
  WebExposuresApi,
  WebSignalsApi,
  WebReleasesApi,
  DEFAULT_SIGNAL_ATTRIBUTE_ALLOWLIST,
} from './client.js';
export type { FireweaveWebClientOptions, ExtensionResult, ReleaseResult } from './client.js';
