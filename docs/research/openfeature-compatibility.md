# OpenFeature Compatibility Research (Fireweave SDK)

**Author:** Agent B — OpenFeature standards researcher
**Date checked:** 2026-07-27 (all versions/APIs verified against live registries and `main` branches on this date)
**Scope:** Server-side OpenFeature SDKs for Node.js, Python, Go, Java, and the OpenFeature specification. Fireweave implements a custom **provider** in each language; it must never fork or re-implement the OpenFeature SDK itself.

**Primary sources checked (inline citations throughout):**

- Spec repo: https://github.com/open-feature/spec — sections `01-flag-evaluation.md`, `02-providers.md`, `03-evaluation-context.md`, `04-hooks.md`, `05-events.md`, `06-tracking.md`, `types.md`, `appendix-a-included-utilities.md`, `appendix-b-gherkin-suites.md` (all read from `main`)
- Spec releases/tags: https://github.com/open-feature/spec/releases and the GitHub tags API
- Node: https://github.com/open-feature/js-sdk (`packages/server/src/provider/provider.ts`, `packages/shared/src/provider/provider.ts`, `packages/shared/src/evaluation/evaluation.ts`, `packages/server/src/hooks/hook.ts`, `packages/server/README.md`), npm registry (`@openfeature/server-sdk`, `@openfeature/core`)
- Python: https://github.com/open-feature/python-sdk (`openfeature/provider/__init__.py`, `openfeature/hook/__init__.py`, `openfeature/exception.py`, `README.md`), PyPI JSON API (`openfeature-sdk`)
- Go: https://github.com/open-feature/go-sdk (`openfeature/provider.go`, `openfeature/hooks.go`, `openfeature/resolution_error.go`, `README.md`), Go module proxy
- Java: https://github.com/open-feature/java-sdk (`src/main/java/dev/openfeature/sdk/FeatureProvider.java`, `README.md`, GitHub releases API)
- Test harness: https://github.com/open-feature/test-harness (`README.md`)

---

## 1. Version pinning recommendation

All versions verified against live registries on **2026-07-27**:

| Language | Package | Pin | Published | Runtime floor | Notes |
| --- | --- | --- | --- | --- | --- |
| Node.js | `@openfeature/server-sdk` | **1.22.0** | 2026-06-12 | Node.js 18+ | Peer-dep `@openfeature/core` **^1.11.0** (latest core = 1.11.0, 2026-06-12). Declare `@openfeature/server-sdk` as a **peerDependency** of the Fireweave provider package (js-sdk README explicitly requires this to preserve singleton behavior). |
| Python | `openfeature-sdk` | **0.10.0** | 2026-06-01 | Python ≥ 3.10 | **Pre-1.0**: semver does not protect against breaking changes. Pin `openfeature-sdk>=0.10.0,<0.11` and re-validate on each minor. |
| Go | `github.com/open-feature/go-sdk` | **v1.17.2** | 2026-04-07 | Go 1.25 (README: only currently-maintained Go versions supported) | Standard `go.mod` require; Go module semantics already pin exactly. |
| Java | `dev.openfeature:sdk` | **1.21.0** | 2026-06-22 | Java 11+ (compiler target 11) | Server-side only per README. |

**Spec version:** the latest **tagged** spec release is **v0.8.0** (https://github.com/open-feature/spec/releases; confirmed via tags API — no tag newer than v0.8.0 exists as of 2026-07-27). However, the spec's `main` branch contains substantial post-0.8.0 draft content that current SDK releases already partially implement (see §2). Fireweave should target: **spec v0.8.0 semantics as the compliance floor**, with awareness of `main`-branch drafts listed below.

---

## 2. Spec status snapshot (what's stable vs. in flux)

Per the spec's own status badges (read from `main`, 2026-07-27):

| Spec section | Status |
| --- | --- |
| §1 Flag Evaluation API | **Stable** (subsections 1.3, 1.4, 1.6 marked hardening) |
| §1.8 Isolated API Instances | **Experimental** (new, post-0.8.0 draft) |
| §2 Providers | **Stable** (init/shutdown/reconciliation/status subsections hardening; §2.7 tracking support **experimental**) |
| §3 Evaluation Context | **Hardening** (§3.3 transaction context propagation **experimental**) |
| §4 Hooks | **Hardening** |
| §5 Events | **Hardening** |
| §6 Tracking | **Experimental** |

**Important post-0.8.0 draft changes on spec `main` that have NOT yet fully landed in SDKs** (verify before relying on them):

1. **Provider-emitted status events (§2.8 draft):** the draft now says the *provider* must emit `PROVIDER_READY` / `PROVIDER_ERROR` itself before `initialize` terminates, and the SDK derives status purely from events ("Providers must not rely on the SDK to infer status from lifecycle method return values"). **Current shipped SDKs still do the opposite** — all four SDK docs state the SDK synthesizes READY/ERROR from the outcome of `initialize` (e.g., js-sdk `CommonProvider` doc: "When the returned promise resolves, the SDK fires the ProviderEvents.Ready event"; identical statements in the Python/Go/Java READMEs). Fireweave should build to the shipped SDK behavior (SDK synthesizes init events) and track this draft.
2. **Domain-scoped providers (§2.4.3/§1.1.8 draft):** a provider may declare it is `domain-scoped` to prevent binding to multiple domains. Implemented in Node (`CommonProvider.domainScoped?: boolean`); **UNVERIFIED** in Python/Go/Java as of the pinned versions.
3. **`initialize` receives the bound domain (§2.4.1 draft):** implemented in Node (`initialize?(context?, domain?)`); the Python/Go/Java signatures at the pinned versions take only the evaluation context.
4. **Isolated API instances (§1.8, experimental):** implemented in Java 1.21.0 ("support isolated API instances", release notes 2026-06-22). **UNVERIFIED** for Node/Python/Go at the pinned versions.

---

## 3. Cross-language feature matrix

Legend: ✅ supported · 🟡 partial/divergent · 🧪 experimental · ❌ absent · (?) UNVERIFIED

| Feature | Node (`@openfeature/server-sdk` 1.22.0) | Python (`openfeature-sdk` 0.10.0) | Go (`go-sdk` v1.17.2) | Java (`dev.openfeature:sdk` 1.21.0) |
| --- | --- | --- | --- | --- |
| Typed provider resolvers | ✅ async (`Promise<ResolutionDetails<T>>`) | ✅ sync **+ optional async** (`*_async`) | ✅ sync, takes `context.Context` | ✅ sync (`ProviderEvaluation<T>`) |
| Bool / string types | ✅ / ✅ | ✅ / ✅ | ✅ / ✅ | ✅ / ✅ |
| Numbers | 🟡 single `number` resolver | ✅ separate `int` / `float` | ✅ separate `int64` / `float64` | ✅ `Integer` / `Double`, **plus `Long` resolver with default double-backed impl (2^53−1 safe-range checks)** |
| Object/structured values | ✅ `JsonValue` generic | ✅ `Sequence\|Mapping[str, FlagValueType]` | ✅ `any` (`InterfaceResolutionDetail`) | ✅ `Value` wrapper type |
| Evaluation context layers (API→transaction→client→invocation→before-hooks) | ✅ | ✅ | ✅ (transaction ctx carried on `context.Context`) | ✅ |
| Context shape passed to provider | ✅ structured `EvaluationContext` | ✅ structured `EvaluationContext` | 🟡 **`FlattenedContext` (flat `map[string]any`, `targetingKey` key)** | ✅ structured `EvaluationContext` (`Value` attrs) |
| Hooks (before/after/error/finally) | ✅ (`finally`) | ✅ (`finally_after`) | ✅ (`Finally`; all 4 methods required — use `UnimplementedHook` embed) | ✅ (`finallyAfter`) |
| Hook data (spec §4.6) | ✅ (`TData` generic on `Hook`) | ✅ (`HookContext.hook_data`, mutable mapping) | ❌ not in `HookContext` (flagKey/type/default/metadata/evalCtx only) | (?) UNVERIFIED at 1.21.0 |
| Provider hooks (`hooks` member) | ✅ `readonly hooks?: Hook[]` | ✅ `get_provider_hooks()` | ✅ `Hooks() []Hook` | ✅ `getProviderHooks()` (default empty) |
| Provider lifecycle (initialize/shutdown) | ✅ `initialize?()`/`onClose?()` | ✅ `initialize()`/`shutdown()` | ✅ opt-in `StateHandler` (`Init`/`Shutdown`) + **`ContextAwareStateHandler`** (`InitWithContext`/`ShutdownWithContext`) | ✅ default methods `initialize()`/`shutdown()` |
| Provider status (NOT_READY/READY/ERROR/STALE/FATAL) | ✅ SDK-owned (`status` member **deprecated**) | ✅ SDK-owned (`ProviderStatus` enum) | ✅ SDK-owned (`State` consts) | ✅ SDK-owned (`getState()` **deprecated**) |
| Events (READY/ERROR/CONFIG_CHANGED/STALE) | ✅ `events?: ProviderEventEmitter` | ✅ `attach(on_emit)`/`detach()` callback + `AbstractProvider.emit_*` helpers | ✅ opt-in `EventHandler` interface exposing `EventChannel() <-chan Event` | ✅ extend `EventProvider`, `emitProvider*()` methods |
| Domains / named providers | ✅ `setProvider('domain', p)` / `getClient('domain')` | ✅ `set_provider(p, 'domain')` / `get_client('domain')` | ✅ `SetNamedProvider` / `NewClient('domain')` | ✅ `setProvider('domain', p)` / `getClient('domain')` |
| `setProviderAndWait` (blocking set) | ✅ | ✅ `set_provider_and_wait` | ✅ `SetProviderAndWait` / `SetNamedProviderAndWait` | ✅ `setProviderAndWait` |
| Tracking API (spec §6 = experimental) | 🧪 `client.track()` + provider `track?()` | 🧪 `client.track()` + provider `track()` | 🧪 `client.Track()` + opt-in `Tracker` interface | 🧪 `client.track()` + default provider `track()`; **throws `IllegalArgumentException` on empty event name** |
| Transaction context propagation (spec §3.3 = experimental) | 🧪 `AsyncLocalStorageTransactionContextPropagator` | 🧪 `ContextVarsTransactionContextPropagator` | 🧪 **no propagator interface** — `WithTransactionContext(ctx, ec)` / `MergeTransactionContext` on `context.Context` | 🧪 `ThreadLocalTransactionContextPropagator` + `setTransactionContext` |
| Multi-provider | ✅ built into server-sdk (`MultiProvider` + FirstMatch/FirstSuccessful/Comparison strategies) | ❌ not in core SDK (README feature table omits it; contrib status UNVERIFIED) | 🧪 experimental `openfeature/multi` package | 🧪 experimental `dev.openfeature.sdk.multiprovider` |
| Isolated API instances (spec §1.8 experimental) | (?) UNVERIFIED | ❌ (module-level singleton API) | (?) UNVERIFIED | 🧪 shipped in 1.21.0 |
| In-memory provider (spec appendix A) | ✅ `InMemoryProvider` / `TypedInMemoryProvider` | ✅ `openfeature.provider.in_memory_provider.InMemoryProvider` | ✅ `memprovider.NewInMemoryProvider` **+ `testing.NewTestProvider`** (thread-safe, per-test flags) + mocks behind `testtools` build tag | ✅ `InMemoryProvider` (used in README quick start) |
| All 8 error codes incl. `PROVIDER_FATAL` | ✅ (`ErrorCode` enum in `@openfeature/core`) | ✅ (`openfeature.exception.ErrorCode` + typed exceptions) | ✅ (`ResolutionError` constructors, `NewProviderFatalResolutionError` etc.) | ✅ (verified `TYPE_MISMATCH` etc. in source; `FatalError` exception referenced in `FeatureProvider` javadoc) |
| All 9 standard reasons | ✅ `StandardResolutionReasons` | ✅ (README/`flag_evaluation`) | 🟡 **`STALE` reason constant absent** from `provider.go` reason consts (STATIC/DEFAULT/TARGETING_MATCH/SPLIT/CACHED/DISABLED/UNKNOWN/ERROR present; `Reason` is an open string type, so `"STALE"` can still be returned) | ✅ (`Reason` enum; ERROR verified in source) |

---

## 4. Minimum provider contract Fireweave must implement, per language

The resolution-detail structure is uniform in spirit across languages (spec `types.md#resolution-details`): `value` (required), `variant?`, `reason?`, `errorCode?`, `errorMessage?`, `flagMetadata?`. Field names/casing and error-signaling idiom differ per language, below.

### 4.1 Node.js (`@openfeature/server-sdk` 1.22.0)

Source: `packages/server/src/provider/provider.ts`, `packages/shared/src/provider/provider.ts`.

```typescript
class FireweaveProvider implements Provider {
  readonly runsOn = 'server';                       // paradigm guard, enforced by SDK
  readonly metadata = { name: 'fireweave' } as const;
  readonly hooks?: Hook[];                           // optional provider hooks
  events = new OpenFeatureEventEmitter();            // optional; emit ProviderEvents.*

  // ALL resolvers are async and receive a per-evaluation Logger (Node-only param!)
  resolveBooleanEvaluation(flagKey: string, defaultValue: boolean,
    context: EvaluationContext, logger: Logger): Promise<ResolutionDetails<boolean>>;
  resolveStringEvaluation(flagKey: string, defaultValue: string,
    context: EvaluationContext, logger: Logger): Promise<ResolutionDetails<string>>;
  resolveNumberEvaluation(flagKey: string, defaultValue: number,
    context: EvaluationContext, logger: Logger): Promise<ResolutionDetails<number>>;
  resolveObjectEvaluation<T extends JsonValue>(flagKey: string, defaultValue: T,
    context: EvaluationContext, logger: Logger): Promise<ResolutionDetails<T>>;

  // lifecycle (optional): SDK fires Ready on resolve, Error on reject
  initialize?(context?: EvaluationContext, domain?: string): Promise<void>;
  onClose?(): Promise<void>;                         // NOTE: named onClose, not shutdown
  track?(name: string, ctx: EvaluationContext, details: TrackingEventDetails): void;
  // do NOT implement `status` — deprecated; SDK owns state
}
```

Error signaling: throw typed errors from `@openfeature/core` (e.g. `FlagNotFoundError`) or return `errorCode` in `ResolutionDetails`; the SDK catches and maps to default-value evaluation details.

### 4.2 Python (`openfeature-sdk` 0.10.0)

Source: `openfeature/provider/__init__.py`. Extend `AbstractProvider` (it wires event emission via `attach`/`detach` and provides `emit_provider_ready` / `emit_provider_error` / `emit_provider_stale` / `emit_provider_configuration_changed`).

```python
class FireweaveProvider(AbstractProvider):
    def get_metadata(self) -> Metadata: ...                       # abstract
    def get_provider_hooks(self) -> list[Hook]: return []
    def initialize(self, evaluation_context: EvaluationContext) -> None: ...
    def shutdown(self) -> None: ...

    # abstract sync resolvers; raise openfeature.exception.* on abnormal execution
    def resolve_boolean_details(self, flag_key: str, default_value: bool,
        evaluation_context: EvaluationContext | None = None) -> FlagResolutionDetails[bool]: ...
    def resolve_string_details(...) -> FlagResolutionDetails[str]: ...
    def resolve_integer_details(...) -> FlagResolutionDetails[int]: ...
    def resolve_float_details(...) -> FlagResolutionDetails[float]: ...
    def resolve_object_details(self, flag_key: str,
        default_value: Sequence[FlagValueType] | Mapping[str, FlagValueType],
        evaluation_context: EvaluationContext | None = None
    ) -> FlagResolutionDetails[Sequence[FlagValueType] | Mapping[str, FlagValueType]]: ...

    # OPTIONAL async twins (default to delegating to sync); implement for real async support
    async def resolve_boolean_details_async(...) -> FlagResolutionDetails[bool]: ...
    # ... _async variants for all five types

    def track(self, tracking_event_name, evaluation_context=None,
              tracking_event_details=None) -> None: ...
```

Error signaling: raise `FlagNotFoundError`, `TypeMismatchError`, `ParseError`, `InvalidContextError`, `TargetingKeyMissingError`, `ProviderNotReadyError`, `ProviderFatalError`, `GeneralError` (`openfeature/exception.py`).

### 4.3 Go (`github.com/open-feature/go-sdk` v1.17.2)

Source: `openfeature/provider.go`. Core interface is mandatory; lifecycle/events/tracking are opt-in interfaces.

```go
type FireweaveProvider struct{}

// REQUIRED: openfeature.FeatureProvider
func (p *FireweaveProvider) Metadata() openfeature.Metadata
func (p *FireweaveProvider) BooleanEvaluation(ctx context.Context, flag string,
    defaultValue bool, flatCtx openfeature.FlattenedContext) openfeature.BoolResolutionDetail
func (p *FireweaveProvider) StringEvaluation(ctx context.Context, flag string,
    defaultValue string, flatCtx openfeature.FlattenedContext) openfeature.StringResolutionDetail
func (p *FireweaveProvider) FloatEvaluation(ctx context.Context, flag string,
    defaultValue float64, flatCtx openfeature.FlattenedContext) openfeature.FloatResolutionDetail
func (p *FireweaveProvider) IntEvaluation(ctx context.Context, flag string,
    defaultValue int64, flatCtx openfeature.FlattenedContext) openfeature.IntResolutionDetail
func (p *FireweaveProvider) ObjectEvaluation(ctx context.Context, flag string,
    defaultValue any, flatCtx openfeature.FlattenedContext) openfeature.InterfaceResolutionDetail
func (p *FireweaveProvider) Hooks() []openfeature.Hook

// OPTIONAL: openfeature.StateHandler — prefer ContextAwareStateHandler (adds
// InitWithContext/ShutdownWithContext for timeout/cancellation support; SDK calls the
// context-aware pair when both are implemented)
func (p *FireweaveProvider) Init(ec openfeature.EvaluationContext) error
func (p *FireweaveProvider) Shutdown()
func (p *FireweaveProvider) InitWithContext(ctx context.Context, ec openfeature.EvaluationContext) error
func (p *FireweaveProvider) ShutdownWithContext(ctx context.Context) error

// OPTIONAL: openfeature.EventHandler
func (p *FireweaveProvider) EventChannel() <-chan openfeature.Event

// OPTIONAL: openfeature.Tracker
func (p *FireweaveProvider) Track(ctx context.Context, name string,
    ec openfeature.EvaluationContext, details openfeature.TrackingEventDetails)
```

Result type: `GenericResolutionDetail[T]{ Value T; ProviderResolutionDetail{ ResolutionError, Reason, Variant, FlagMetadata } }`. Error signaling: set `ResolutionError` via the constructor functions in `resolution_error.go` (`NewFlagNotFoundResolutionError(msg)`, `NewProviderFatalResolutionError(msg)`, …) — the `ResolutionError` struct has unexported fields, so constructors are the only path. **Providers receive `FlattenedContext` (a flat `map[string]any` with `"targetingKey"`), not the structured `EvaluationContext`.**

### 4.4 Java (`dev.openfeature:sdk` 1.21.0)

Source: `src/main/java/dev/openfeature/sdk/FeatureProvider.java`.

```java
public class FireweaveProvider implements FeatureProvider {   // or extends EventProvider
    @Override public Metadata getMetadata() { return () -> "fireweave"; }
    // getProviderHooks() has a default (empty) implementation

    @Override public ProviderEvaluation<Boolean> getBooleanEvaluation(
        String key, Boolean defaultValue, EvaluationContext ctx) { ... }
    @Override public ProviderEvaluation<String>  getStringEvaluation(String key, String def, EvaluationContext ctx) { ... }
    @Override public ProviderEvaluation<Integer> getIntegerEvaluation(String key, Integer def, EvaluationContext ctx) { ... }
    @Override public ProviderEvaluation<Double>  getDoubleEvaluation(String key, Double def, EvaluationContext ctx) { ... }
    @Override public ProviderEvaluation<Value>   getObjectEvaluation(String key, Value def, EvaluationContext ctx) { ... }

    // NEW in current SDK: 64-bit longs. Default impl delegates to getDoubleEvaluation and
    // returns TYPE_MISMATCH outside ±(2^53−1) or for non-integral doubles.
    // Fireweave SHOULD override for lossless long support:
    @Override public ProviderEvaluation<Long> getLongEvaluation(String key, Long def, EvaluationContext ctx) { ... }

    // default no-op lifecycle; exceptions from initialize -> ERROR (FatalError -> FATAL)
    @Override public void initialize(EvaluationContext evaluationContext) throws Exception { ... }
    @Override public void shutdown() { ... }
    // getState() is @Deprecated — do not implement; SDK owns state
    @Override public void track(String eventName, EvaluationContext ctx, TrackingEventDetails details) { ... }
}
```

Error signaling: throw exceptions from `dev.openfeature.sdk.exceptions` (e.g. `FatalError` → FATAL) or populate `errorCode`/`errorMessage` on the `ProviderEvaluation` builder. For events, extend `EventProvider` and call `emitProviderConfigurationChanged(...)` etc.

---

## 5. Evaluation context model (all languages)

- **targetingKey** (string, optional at the structure level; providers may require it — spec §3.1.1). Node: `targetingKey` property on a plain object. Python: `EvaluationContext(targeting_key=..., attributes={...})`. Go: first arg of `openfeature.NewEvaluationContext(targetingKey, attrs)`; reaches the provider as the `"targetingKey"` key of `FlattenedContext`. Java: constructor arg of `ImmutableContext(targetingKey, attrs)`.
- **Attribute value types** (spec §3.1.2): `boolean | string | number | datetime | structure`. Java wraps everything in `Value`; Go uses `map[string]any`; Node uses JSON-compatible values; Python uses arbitrary `attributes` dict values.
- **Merge order** (spec §3.2.3, verified normative on `main`): **API (global) → transaction → client → invocation → before-hook output**, later wins on key conflicts. All four SDKs implement all five layers (Go's "transaction" layer rides on `context.Context` rather than an API-level propagator).
- Keys must be unique across the context (§3.1.4); the SDK — not the provider — performs the merge, and the provider receives the merged context (Go: flattened).

## 6. Hooks (per-language signatures, verified from source)

Spec §4 (hardening). Stages: `before`, `after`, `error`, `finally`. Execution order (spec §4.4.2): **before = API → Client → Invocation → Provider; after/error/finally = reverse**, with per-level insertion order forward for before and reversed for after. Failure isolation (spec §4.4.3–4.4.7): errors in `error`/`finally` hooks are swallowed; an error in `before`/`after` skips remaining hooks in that stage, triggers `error` hooks, and evaluation returns the default value.

| | before | after | error | finally |
| --- | --- | --- | --- | --- |
| Node (`BaseHook`) | `(hookContext, hints)` → `EvaluationContext \| void` (may be `Promise`) | `(hookContext, evaluationDetails, hints)` (may be `Promise`) | `(hookContext, err, hints)` | `finally(hookContext, evaluationDetails, hints)` |
| Python (`Hook` class) | `before(hook_context, hints)` → `EvaluationContext \| None` | `after(hook_context, details, hints)` | `error(hook_context, exception, hints)` | **`finally_after(...)`** (reserved word) |
| Go (`Hook` interface) | `Before(ctx, hookContext, hookHints)` → `(*EvaluationContext, error)` | `After(ctx, hookContext, details, hookHints) error` | `Error(ctx, hookContext, err, hookHints)` | `Finally(ctx, hookContext, details, hookHints)` |
| Java (`Hook<T>`) | `before(hookContext, hints)` → `Optional<EvaluationContext>` | `after(hookContext, details, hints)` | `error(hookContext, exception, hints)` | **`finallyAfter(...)`** (reserved word) |

Extras: Go requires all four methods (embed `openfeature.UnimplementedHook`); Go hook methods additionally receive `context.Context`, and `After` can return an error. Hook data (spec §4.6, per-hook per-evaluation mutable store) exists in Node (`TData` generic) and Python (`HookContext.hook_data`); Go's `HookContext` has no hook-data field; Java 1.21.0 hook-data support UNVERIFIED. Python adds a non-spec `supports_flag_value_type()` filter method.

## 7. Lifecycle, status & events

- **Status enum** (all four, SDK-owned): `NOT_READY`, `READY`, `ERROR`, `STALE`, `FATAL` (`RECONCILING` is client-paradigm-only and correctly absent from all four server SDKs).
- **Ownership:** in all four pinned SDKs, **the SDK tracks provider status**; provider-side status members are deprecated (Node `CommonProvider.status`, Java `getState()`) or never existed (Python, Go). Query status from the client (`client.providerStatus` / Java `client.getProviderState()` / Go & Python equivalents).
- **Initialization semantics (shipped behavior):** SDK calls `initialize`/`Init` when the provider is set; on normal termination the SDK fires `PROVIDER_READY` and sets status READY; on abnormal termination it fires `PROVIDER_ERROR` and sets ERROR — or **FATAL** when the error carries `PROVIDER_FATAL` (Java: throw `FatalError`; Go: `ProviderInitError{ErrorCode: ProviderFatalCode}`; Node: error with fatal code; Python: raise `ProviderFatalError`). `FATAL` and `NOT_READY` short-circuit evaluation to the default value with the corresponding error code. ⚠️ Spec `main` draft §2.8 moves READY/ERROR emission into the provider itself — not yet shipped SDK behavior; see §2.
- **Events:** `PROVIDER_READY`, `PROVIDER_ERROR`, `PROVIDER_CONFIGURATION_CHANGED`, `PROVIDER_STALE` supported in all four (mechanisms differ; see matrix). Handlers registered at API and client level; handlers attached while already in the matching state run immediately (spec §5.3.3). Event handlers survive provider changes (§5.2.6).
- **Shutdown:** SDK calls provider shutdown (`onClose` in Node) when replaced or on API shutdown; SDK infers `NOT_READY` afterward (spec §1.7.6). Shutdown should be idempotent (§2.5.3). API-level `shutdown`/`close` also resets API state — hooks, contexts, propagators (spec §1.6.2; implemented in Java 1.21.0 per release notes).

## 8. Error semantics

- **Codes** (verified present in all four SDKs): `PROVIDER_NOT_READY`, `PROVIDER_FATAL`, `FLAG_NOT_FOUND`, `PARSE_ERROR`, `TYPE_MISMATCH`, `TARGETING_KEY_MISSING`, `INVALID_CONTEXT`, `GENERAL`.
- **Reasons** (spec `types.md`): `STATIC`, `DEFAULT`, `TARGETING_MATCH`, `SPLIT`, `CACHED`, `DISABLED`, `UNKNOWN`, `STALE`, `ERROR` — reason is an *open* string, custom reasons allowed. (Go omits a `STALE` reason constant but accepts any string.)
- **Never-throw contract** (spec §1.4.10): client evaluation methods must not throw; on abnormal execution the client returns the **default value** with `reason=ERROR` + `errorCode` populated. Providers signal errors idiomatically (throw in Node/Python/Java, `ResolutionError` struct in Go); the SDK converts them.
- **No logging in evaluation paths** (spec §1.4.11): Fireweave's provider should not log during resolution; ship/recommend the SDK's `LoggingHook` (exists in Python, Go, Java; appendix A defines its shape) for debugging.
- Normal execution: `value` (required), `variant` SHOULD, `reason` SHOULD, `flagMetadata` SHOULD (string keys; bool/string/number values); `errorCode`/`errorMessage` MUST be unset (spec §2.2.3–2.2.10, §2.3.2).

---

## 9. Stable-feature baseline (Fireweave phase one)

Build phase one on features that are spec-Stable/Hardening **and** shipped consistently in all four SDKs:

1. **Typed resolvers** for boolean, string, int, float, object per language contract in §4 (Node: single number resolver; Java: also override `getLongEvaluation`).
2. **Metadata** (`name: "fireweave"`) and **provider hooks** member (return empty initially).
3. **Lifecycle:** `initialize` + `shutdown` (Go: implement `ContextAwareStateHandler`; Node: `onClose`). Fail initialization abnormally on bad credentials/config using the fatal idiom per language.
4. **Status/eventing:** rely on SDK-synthesized READY/ERROR for init; additionally implement the per-language event emitters so Fireweave can emit `PROVIDER_CONFIGURATION_CHANGED` (on flag-config refresh from the PostHog backend adapter) and `PROVIDER_STALE`/`PROVIDER_ERROR`/`PROVIDER_READY` (on poller/connection health transitions).
5. **Error semantics:** map backend-adapter failures to the 8 standard codes; always resolvable to defaults, never throw out of the client path.
6. **Evaluation context:** honor `targetingKey` as the cohort/distinct-id key; accept arbitrary attributes; document the mapping to PostHog person/group properties. Support all context layers (they're SDK-side; the provider just consumes the merged context — flattened in Go).
7. **Domains:** no provider-side work needed beyond statelessness across domains (or declaring domain scoping later); document that Fireweave providers are safe to bind to multiple domains, or not.
8. **In-memory-style test provider parity** for tests (use the official ones; see §11).

## 10. Experimental-feature quarantine plan

Isolate anything spec-Experimental or SDK-divergent behind clearly-marked, separately-importable modules so core Fireweave never depends on unstable surface:

| Feature | Spec status | Quarantine approach |
| --- | --- | --- |
| **Tracking** (`client.track` → provider `track`) | Experimental (§6/§2.7) | Implement provider `track` in all four (it's the natural hook for Fireweave release-safety telemetry), but (a) keep it no-op-safe, (b) mark it `@experimental` in Fireweave docs, (c) never let core evaluation depend on it. Note Java's empty-name `IllegalArgumentException` divergence in docs. |
| **Transaction context propagation** | Experimental (§3.3) | Zero provider-side work required (SDK merges it before the provider sees context). Document per-language usage only; do not build Fireweave APIs on top of it. |
| **Multi-provider** | Appendix A (non-normative) | Do not depend on it. Document "Fireweave works under Multi-Provider" as untested in Python (absent from core SDK). |
| **Isolated API instances** | Experimental (§1.8, only Java shipped) | Ignore in phase one; ensure Fireweave provider instances hold no global state so they work if/when users adopt isolated instances. |
| **Domain-scoped provider declaration** / **`initialize(context, domain)`** | Post-0.8.0 draft (Node only) | Do not declare `domainScoped`. In Node, accept but ignore the optional `domain` param. |
| **Provider-emitted init events (spec `main` §2.8 draft)** | Draft, not shipped | Track upstream. Encapsulate event emission behind one internal Fireweave "lifecycle notifier" per language so switching from SDK-synthesized to provider-emitted init events is a one-place change. |
| **Python SDK 0.x churn** | n/a | Pin `<0.11`; wrap all imports from `openfeature.*` behind a thin internal compat module in the Fireweave Python provider so upstream renames touch one file. |

## 11. Conformance strategy

Goal: prove "Fireweave is a spec-compliant OpenFeature provider" per language **without flagd**.

1. **Spec-derived assertion checklist.** The spec's conformance clause says each normative H5 section is one test assertion. Generate a checklist from spec v0.8.0 sections §1–§5 (provider-relevant requirements: 2.1.1, 2.2.x, 2.3.x, 2.4.x, 2.5.x, plus error/reason tables in `types.md`) and track it in a single matrix shared across the four implementations.
2. **Official Gherkin evaluation suite (no flagd needed).** Spec Appendix B (`specification/assets/gherkin/evaluation.feature`) is explicitly designed to run against an **in-memory provider** with a cucumber runner per language (Appendix A: "E2E tests must utilize in-memory provider... and must be self-contained"). Adapt the same feature file to run against a Fireweave provider backed by a stubbed/faked backend adapter (in-memory PostHog fake). Runners: `@cucumber/cucumber` (Node), `behave`/`pytest-bdd` (Python), `godog` (Go), `cucumber-jvm` (Java).
3. **SDK-integration tests via official test utilities.** Register the Fireweave provider through the real SDK (`setProviderAndWait`, hooks attached at all four levels, event handlers registered) and assert: default-value-on-error behavior, all 8 error codes, reason propagation, flag metadata passthrough, hook ordering, event emission on config change, shutdown idempotency. Use `testing.NewTestProvider`/`testtools` mocks (Go) and the in-memory providers as reference behavior oracles: for every scenario, run it against the official in-memory provider and against Fireweave-with-fake-backend and diff the evaluation details.
4. **flagd test-harness: optional, not required.** https://github.com/open-feature/test-harness is a flagd-testbed Docker image (flagd + "launchpad" REST control plane, gherkin suites tagged `@file`/`@rpc`/`@in-process`). It tests *flagd providers*, not arbitrary providers — do **not** adopt it for Fireweave certification; do borrow its structure (submodule of versioned gherkin files, tag-based feature exclusion, testcontainers) for Fireweave's own cross-language harness against a containerized PostHog/Fireweave fake.
5. **CI matrix:** run the shared gherkin suite across {4 languages} × {pinned SDK version, latest SDK version} to catch upstream drift early (especially Python 0.x).

## 12. Known cross-language inconsistencies Fireweave must paper over or document

1. **Sync vs async resolvers:** Node is async-only (`Promise`); Python is sync-first with optional `*_async` twins; Go and Java are sync (Go takes `context.Context` for cancellation). Fireweave's backend adapter must expose both sync and async evaluation paths (or a sync core with async wrappers) to serve all four naturally.
2. **Context shape at the provider boundary:** Go providers receive a **flattened** `map[string]any` (`FlattenedContext`, targeting key under `"targetingKey"`); the other three receive structured context objects. Fireweave's context→PostHog mapping layer needs a flattening-aware normalizer.
3. **Numeric typing:** Node has one `number` resolver; Python `int`/`float`; Go `int64`/`float64`; Java `Integer`/`Double` **plus** a `Long` resolver whose default implementation silently clamps to the ±(2^53−1) double-safe range with `TYPE_MISMATCH` outside it. Document that Fireweave int flags are reliable only within 2^53−1 cross-language; override `getLongEvaluation` in Java for native longs.
4. **Object/structured values:** `JsonValue` (Node) vs `Sequence|Mapping` (Python) vs `any` (Go) vs `Value` wrapper (Java). Fireweave must define one canonical JSON-ish payload model and per-language marshalling.
5. **Lifecycle method names/mechanics:** `initialize`/`onClose` (Node), `initialize`/`shutdown` (Python, Java), opt-in `StateHandler.Init`/`Shutdown` + `ContextAwareStateHandler` (Go). Only Node's `initialize` receives the bound `domain`.
6. **Event plumbing:** emitter object (Node) vs `attach(on_emit)` callback (Python) vs event channel (Go) vs `EventProvider` base class (Java). Wrap in a per-language internal "lifecycle notifier."
7. **Hook shape:** stage-name divergence (`finally` / `finally_after` / `Finally` / `finallyAfter`); Go hooks are all-methods-required, receive `context.Context`, and `Before`/`After` return errors; Java `before` returns `Optional<EvaluationContext>`; hook data missing in Go (and UNVERIFIED in Java). Fireweave's OTel/telemetry hooks (if shipped) can't rely on hook data portably — use per-evaluation correlation via flag metadata instead.
8. **Error signaling idiom:** exceptions (Node/Python/Java) vs constructor-built `ResolutionError` value in the result struct (Go, unexported fields — constructors mandatory).
9. **Node-only `Logger` parameter** on every resolver; no equivalent elsewhere.
10. **Transaction context:** propagator-object API (Node/Python/Java) vs `context.Context` carriage (Go).
11. **Tracking edge case:** Java `client.track` throws `IllegalArgumentException` on an empty event name; other SDKs' behavior for empty names is UNVERIFIED — validate event names in Fireweave before delegating.
12. **Multi-provider availability:** built into Node server-sdk, experimental in Go/Java, **absent from Python core**.
13. **Maturity skew:** Python is pre-1.0 (0.10.0) while the others are mature 1.x — expect breaking changes only there; the compat-module quarantine (§10) addresses this.
14. **`STALE` reason constant** absent from Go's predefined reasons (open string type mitigates; Fireweave can still emit `"STALE"`).

---

## Appendix: verification notes

- Everything above marked ✅ was verified directly from source files, registry metadata, or release notes fetched on 2026-07-27; items marked **(?) UNVERIFIED** could not be confirmed from primary sources during this pass and must not be assumed.
- The per-SDK "spec compliance version" badges shown on openfeature.dev were not machine-verifiable in this pass (badge images stripped from fetched READMEs); the compliance floor stated in §1 (spec v0.8.0 tagged + partial `main` drafts) is derived from tagged releases plus feature evidence in SDK sources/release notes, which is stronger evidence than the badges.
