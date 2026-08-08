/**
 * v2 → v3 TYPE-surface backward-compatibility guard. Never executed — it exists
 * to be typechecked (`tsc -p test/tsconfig.json --noEmit`, which includes
 * `../packages/sdk/test/**\/*.ts`).
 *
 * Every type export v2.0.0 published is referenced below. Removing one, or
 * narrowing it so a v2 usage no longer compiles, breaks the build here instead
 * of breaking a consumer silently.
 *
 * DO NOT edit a reference here to make a change pass — see the header of
 * v2-surface.compat.test.ts.
 *
 * Known-intentional narrowings, documented in docs/adr/0006 and the CHANGELOG:
 *   - BackendAdapter.name drops 'posthog'
 *   - Capabilities.runtime.backend drops 'posthog'
 * Those two are asserted as narrowed on purpose at the bottom of this file.
 */
import type {
  AdapterResolution,
  AdapterRuntimeFeatures,
  BackendAdapter,
  CanonicalContext,
  Capabilities,
  ContextInput,
  ContextLimits,
  ContextPolicy,
  Decision,
  DecisionReason,
  ErrorKindSpec,
  EvaluateOptions,
  ExpectedFlagType,
  Exposure,
  ExposureResult,
  ExtensionResult,
  FireweaveClientOptions,
  FireweaveErrorKind,
  FireweaveProviderOptions,
  FireweaveRemoteAdapterOptions,
  FireweaveRuntimeConfig,
  FlagValueType,
  InMemoryAdapterOptions,
  InMemoryFault,
  InMemoryFlagDefinition,
  JsonValue,
  LifecycleState,
  OpenFeatureErrorCode,
  RegisterTargetOptions,
  RegisterTargetResult,
  ReleaseContext,
  ReleaseResult,
  ReleaseState,
  ReleaseStatus,
  ResolveOptions,
  Signal,
  SignalKind,
  SignalResult,
  TargetKind,
  TelemetryPolicy,
} from '@fireweaveai/sdk';

/** Identity: forces T to resolve; a removed type becomes a compile error. */
type Pinned<T> = T;

/** Asserts `Narrow` is assignable to `Wide` — pins union members that must survive. */
type Includes<Wide, Narrow extends Wide> = Pinned<Narrow>;

// --- errors -----------------------------------------------------------------
declare const errorKind: Pinned<FireweaveErrorKind>;
declare const ofErrorCode: Pinned<OpenFeatureErrorCode>;
declare const errorKindSpec: Pinned<ErrorKindSpec>;

// --- core value + decision model -------------------------------------------
declare const jsonValue: Pinned<JsonValue>;
declare const decision: Pinned<Decision>;
declare const decisionReason: Pinned<DecisionReason>;
declare const canonicalContext: Pinned<CanonicalContext>;
declare const lifecycleState: Pinned<LifecycleState>;
declare const flagValueType: Pinned<FlagValueType>;

// `flagKey` stays the field name on every envelope (spec/*.schema.json).
declare const decisionFlagKey: Pinned<Decision['flagKey']>;
declare const exposureFlagKey: Pinned<Exposure['flagKey']>;
declare const signalFlagKey: Pinned<Signal['flagKey']>;
declare const decisionMetadata: Pinned<Decision['metadata']>;

// --- telemetry + release model ---------------------------------------------
declare const signal: Pinned<Signal>;
declare const signalKind: Pinned<SignalKind>;
declare const releaseContext: Pinned<ReleaseContext>;
declare const releaseState: Pinned<ReleaseState>;
declare const releaseStatus: Pinned<ReleaseStatus>;
declare const exposure: Pinned<Exposure>;
declare const capabilities: Pinned<Capabilities>;

// --- context ---------------------------------------------------------------
declare const contextInput: Pinned<ContextInput>;
declare const contextLimits: Pinned<ContextLimits>;
declare const contextPolicy: Pinned<ContextPolicy>;

// --- adapter boundary ------------------------------------------------------
declare const backendAdapter: Pinned<BackendAdapter>;
declare const adapterResolution: Pinned<AdapterResolution>;
declare const adapterRuntimeFeatures: Pinned<AdapterRuntimeFeatures>;
declare const registerTargetOptions: Pinned<RegisterTargetOptions>;
declare const registerTargetResult: Pinned<RegisterTargetResult>;
declare const resolveOptions: Pinned<ResolveOptions>;
declare const targetKind: Pinned<TargetKind>;

// The local-evaluation seam survives the PostHog removal (ADR-0006): a future
// Fireweave-native cache reports through these same fields.
declare const localEvaluation: Pinned<AdapterRuntimeFeatures['localEvaluation']>;
declare const localOnly: Pinned<AdapterRuntimeFeatures['localOnly']>;
declare const fromCache: Pinned<AdapterResolution['fromCache']>;
declare const quotaLimited: Pinned<AdapterResolution['quotaLimited']>;
declare const vendorFlagId: Pinned<AdapterResolution['vendorFlagId']>;

// --- adapters --------------------------------------------------------------
declare const inMemoryAdapterOptions: Pinned<InMemoryAdapterOptions>;
declare const inMemoryFlagDefinition: Pinned<InMemoryFlagDefinition>;
declare const inMemoryFault: Pinned<InMemoryFault>;
declare const remoteAdapterOptions: Pinned<FireweaveRemoteAdapterOptions>;

// The in-memory test path keeps its `flags` option key — renaming it would
// break every consumer test suite.
declare const inMemoryFlagsOption: Pinned<InMemoryAdapterOptions['flags']>;

// --- runtime / provider / client -------------------------------------------
declare const runtimeConfig: Pinned<FireweaveRuntimeConfig>;
declare const evaluateOptions: Pinned<EvaluateOptions>;
declare const expectedFlagType: Pinned<ExpectedFlagType>;
declare const providerOptions: Pinned<FireweaveProviderOptions>;
declare const clientOptions: Pinned<FireweaveClientOptions>;
declare const extensionResult: Pinned<ExtensionResult>;
declare const releaseResult: Pinned<ReleaseResult>;
declare const exposureResult: Pinned<ExposureResult>;
declare const signalResult: Pinned<SignalResult>;
declare const telemetryPolicy: Pinned<TelemetryPolicy>;

// --- union members that must survive ---------------------------------------
type _Reasons = Includes<
  DecisionReason,
  'STATIC' | 'DEFAULT' | 'TARGETING_MATCH' | 'SPLIT' | 'CACHED' | 'STALE' | 'DISABLED' | 'UNKNOWN' | 'ERROR'
>;
type _Lifecycle = Includes<
  LifecycleState,
  'UNINITIALIZED' | 'INITIALIZING' | 'READY' | 'STALE' | 'ERROR' | 'FATAL' | 'SHUTDOWN'
>;
type _FlagTypes = Includes<FlagValueType, 'boolean' | 'string' | 'number' | 'object'>;
type _ExpectedTypes = Includes<ExpectedFlagType, 'boolean' | 'string' | 'number' | 'object'>;
type _SignalKinds = Includes<SignalKind, 'health' | 'error' | 'metric' | 'outcome'>;
type _ReleaseStatuses = Includes<ReleaseStatus, 'set' | 'in_progress' | 'completed' | 'failed'>;
type _TargetKinds = Includes<TargetKind, 'user' | 'device'>;
type _AdapterNames = Includes<BackendAdapter['name'], 'inmemory' | 'fireweave' | 'other'>;
type _Backends = Includes<
  Capabilities['runtime']['backend'],
  'fireweave' | 'inmemory' | 'none' | 'other'
>;

/*
 * --- intentional narrowings (ADR-0006) -------------------------------------
 * The two assertions below are inverted on purpose: `'posthog'` must NOT be
 * assignable any more. If either directive starts reporting itself as unused,
 * the vendor string leaked back into the published .d.ts.
 */
// @ts-expect-error -- 'posthog' is removed from BackendAdapter['name'] (ADR-0006)
type _NoPosthogAdapterName = Includes<BackendAdapter['name'], 'posthog'>;
// @ts-expect-error -- 'posthog' is removed from the runtime backend union (ADR-0006)
type _NoPosthogBackend = Includes<Capabilities['runtime']['backend'], 'posthog'>;

export type { _NoPosthogAdapterName, _NoPosthogBackend };

export type {
  _AdapterNames,
  _Backends,
  _ExpectedTypes,
  _FlagTypes,
  _Lifecycle,
  _Reasons,
  _ReleaseStatuses,
  _SignalKinds,
  _TargetKinds,
};

export const V2_TYPE_SURFACE_PINNED = true;
