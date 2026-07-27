# ADR-0001: SDK Architecture

- **Status:** Accepted
- **Date:** 2026-07-27
- **Deciders:** Agent D (Architecture & API lead), Phase 2
- **Tags:** architecture, openfeature, posthog, polyglot

## Context and Problem Statement

Fireweave needs an open-source, OpenFeature-compatible polyglot SDK (Node, Python, Go, Java; server-first) that evaluates flags via PostHog in phase one, while exposing Fireweave-specific extension APIs (releases, exposures, signals, guardrails, capabilities, telemetry). Flag evaluation must not reimplement PostHog's evaluator. Public APIs must not leak PostHog types. Evaluation side effects (especially `$feature_flag_called`) must be controllable.

Internal ADR-017 (2026-07-09, Proposed) already decided "thin OpenFeature provider per language wrapping the official vendor SDK" *inside* the private FireWeave monorepo. This public monorepo implements that thin-provider decision and **supersedes ADR-017's in-repo language packs** (`packages/deploy-sdk-py`, planned Go/Rust packs, etc.). Proprietary `@fireweaveai/deploy-sdk` remains prior art and a wire-contract compatibility target; its code is never copied.

## Decision Drivers

- Uniform cross-language semantics and one conformance fixture set
- OpenFeature ecosystem interoperability without forking the OF SDK
- Room for Fireweave extensions beyond flag getters
- Lifecycle/testability control (init, shutdown, exposure, adapters)
- No custom flag evaluator; wrap official PostHog SDKs
- No PostHog types in public APIs
- Spec floor: OpenFeature v0.8.0; PostHog snapshot API (`evaluateFlags`)

## Considered Options

### Option 1 — Direct PostHog wrap (no OpenFeature)

Ship only a Fireweave client that wraps PostHog SDKs. Skip OpenFeature.

- **Pros:** Smaller surface; full control of types and lifecycle.
- **Cons:** Breaks ecosystem interoperability; loses OF hooks/events/domains; fights rollout-server harness (`flags.api: "openfeature"`); eject path becomes Fireweave-specific rather than OF-native.

### Option 2 — OpenFeature provider + FireweaveClient sharing one runtime *(selected)*

`FireweaveProvider` (OF) and `FireweaveClient` (extensions) share a single `FireweaveRuntime` owning a `BackendAdapter` (phase one: `PostHogAdapter`; tests: `InMemoryAdapter`). Flag evaluation goes through OF; releases/signals/guardrails/capabilities go through the client. Public types are Fireweave-owned.

- **Pros:** Matches ADR-017 thin-provider intent; uniform adapter pattern; OF compliance + extensions; testable without PostHog; no dual stacks.
- **Cons:** Slightly larger API surface; must carefully document OF vs Fireweave boundaries.

### Option 3 — Custom supersets of OpenFeature

Extend OF client types / invent a Fireweave-specific flag API that looks like OF but isn't.

- **Pros:** Could add Fireweave fields "naturally."
- **Cons:** Breaks OF interchangeability; users cannot mix MultiProvider/community hooks; high long-term cost; contradicts open-source OF mandate.

### Option 4 — OF via official PostHog providers + Fireweave hooks

Register `@posthog/openfeature-node-provider` / `openfeature-provider-posthog` and bolt Fireweave behavior on via hooks.

- **Pros:** Less flag-mapping code in Node/Python.
- **Cons:** Providers are pre-1.0 / absent in Go/Java; stacks two providers; loses snapshot/`onlyEvaluateLocally`/exposure control; non-uniform cross-language stack (decision brief §4).

### Option 5 — Fireweave remote evaluation service

Route all evaluations through a Fireweave-owned service that talks to PostHog.

- **Pros:** Centralized semantics; single network contract.
- **Cons:** Service does not exist; adds hop/ops; reimplements or proxies evaluation; out of scope for phase one.

## Decision Outcome

**Chosen: Option 2 — OpenFeature provider + FireweaveClient sharing one runtime.**

Research (Agents B/C, decision brief) supports wrapping official PostHog SDKs directly behind a Fireweave-owned OF provider, with a shared runtime for extensions and an in-memory adapter for tests. Option 4 is rejected until official PostHog OF providers reach 1.0 and cover all four languages. Option 5 is deferred. Option 1/3 forfeit OF interoperability required by the product harness.

### Supersession of internal ADR-017

This repository **supersedes ADR-017's planned in-repo language packs**. It **implements** ADR-017's core architectural decision (thin OF provider wrapping the official vendor SDK; `targetingKey` → `distinct_id`). Packaging, licensing, and repo location differ (public polyglot monorepo under MIT assumption). Internal monorepo work on per-language packs should redirect to this repo.

### Consequences

- Positive: one behavioral stack per language; OF conformance via Appendix B + Fireweave fixtures; PostHog types quarantined in adapters; extensions evolve without breaking flag getters.
- Negative: adapter must normalize cross-SDK mismatches (decision brief §5); package/registry names need company ratification.
- Neutral: `@fireweaveai/deploy-sdk` may later re-base on this SDK (company decision).

## Architecture Answers (25 questions)

### 1. PostHog-as-adapter

PostHog is a **backend adapter**, not the public SDK. `PostHogAdapter` implements `BackendAdapter` and wraps the official PostHog SDK per language. Callers never construct PostHog clients for Fireweave flag evaluation unless injecting an existing client (advanced init). See ADR-0002.

### 2. Own OpenFeature provider

Fireweave **authors and owns** `FireweaveProvider` in each language. We do **not** depend on PostHog's OF providers in phase one. Metadata name: `"fireweave"`.

### 3. When to delegate vs wrap

- **Wrap** official PostHog SDKs for evaluation, capture, local-eval polling, flush/shutdown.
- **Delegate** to the OpenFeature SDK for context merge, hooks orchestration, status synthesis, never-throw client evaluation.
- **Never reimplement** cohort matching, definition polling, or flag boolean/multivariate evaluation logic.
- **Do not delegate** to PostHog OF providers (Option 4) until revisited post-1.0.

### 4. Shared client init

`FireweaveRuntime` is constructed once (from config or builder). Both `FireweaveProvider` and `FireweaveClient` hold a reference to the same runtime. Init order: validate config → construct adapter → adapter.init → mark READY. `OpenFeature.setProvider(AndWait)` triggers provider `initialize`, which initializes the shared runtime if not already started. Creating `FireweaveClient` alone also initializes the runtime. Init is idempotent.

### 5. Shutdown ownership

The **runtime** owns shutdown. Provider `onClose`/`shutdown`/`Shutdown` and `FireweaveClient.close()` both call `runtime.shutdown()`. Shutdown is **idempotent**. Default: runtime shuts down the adapter it created. If the caller injected an external PostHog client (`adoptExternalClient: true`), Fireweave **does not** shut it down unless `shutdownExternalClient: true` is set. Fireweave imposes a shutdown deadline (default 10s) around Go's indefinite `Close()` and Node's async shutdown.

### 6. Exposure dedup

Exposure (`$feature_flag_called`) is emitted by the PostHog SDK when snapshot accessors run, with SDK-native LRU dedup. Fireweave normalizes policy: default **emit on OF evaluation** (side-effectful); `evaluationOptions.sendExposure: false` (or equivalent) uses side-effect-free reads when the adapter can do so (payload-only / non-emitting accessors, or PostHog per-call suppress where available). Fireweave may add an optional secondary dedup keyed by `(distinct_id, flag_key, variant)` for extension APIs; it must not double-emit with PostHog's cache. Document Node (50k) vs Java (1k) cache size skew.

### 7. Cold-start defaults

Before the adapter is READY (local-eval: at least one definitions fetch or explicit `reload` success; remote-only: successful client construct), OF evaluation returns the **caller-supplied default** with `PROVIDER_NOT_READY` (or waits if using `setProviderAndWait` until init completes/fails). After READY, missing flags → default + `FLAG_NOT_FOUND`. Quota-limited empty snapshots → default + `FLAG_NOT_FOUND` (not outage). Local-eval cold window may remote-fallback unless `onlyEvaluateLocally`.

### 8. Identity

OpenFeature `targetingKey` **is** the cohort key and maps 1:1 to PostHog `distinct_id`. Fireweave **never auto-generates** an anonymous id per evaluation. Missing `targetingKey` → `InvalidContext` (OF `TARGETING_KEY_MISSING`) + default. Callers must supply a stable key (e.g. `orgId`) for sticky ramps (`verify_cohort_keying`).

### 9. Groups

Evaluation context may include reserved keys `fireweave.groups` (map groupType → groupKey) and `fireweave.groupProperties` (map groupType → property map). Adapter maps these to PostHog `groups` / `group_properties`. Plain context attributes (non-reserved) map to `person_properties`. Group identify remains an extension/client API, not an OF evaluation side effect.

### 10. Payloads without PostHog types

Flag payloads are returned as Fireweave `JsonValue` (JSON-compatible: null/bool/number/string/array/object). Adapter unwraps PostHog snapshot payload strings/objects at the boundary. **No** `FeatureFlagEvaluations`, `PostHog`, or vendor types appear in public method signatures or exported types.

### 11. Capabilities

`capabilities` is a static + runtime matrix: package declares compile-time capabilities (`flags`, `localEvaluation`, `exposures`, `releases`, …); runtime reports adapter-backed availability (e.g. local eval requires secret key). Exposed via `FireweaveClient.capabilities.get()` and schema `capabilities.schema.json`. Used by harness/profile tooling; not an OF API.

### 12. Error mapping

Adapter errors normalize to Fireweave error taxonomy (`errors.schema.json`), then to OF error codes at the provider boundary:

| Fireweave kind | OpenFeature |
|---|---|
| `NotReady` | `PROVIDER_NOT_READY` |
| `FlagNotFound` | `FLAG_NOT_FOUND` (incl. quota-limited empty snapshots; metadata `fireweave.quotaLimited: true`) |
| `TypeMismatch` | `TYPE_MISMATCH` |
| `InvalidContext` | `INVALID_CONTEXT` (`TARGETING_KEY_MISSING` when targeting key required/missing) |
| `MalformedResponse` | `PARSE_ERROR` |
| `Configuration` | `PROVIDER_FATAL` (init-fatal) / `GENERAL` (runtime) |
| `AlreadyClosed` | `PROVIDER_NOT_READY` (kind preserved in `fireweave.errorKind` metadata) |
| `Authentication` / `Authorization` / `RateLimited` / `Timeout` / `Network` / `BackendUnavailable` / `UnsupportedCapability` / `Internal` | `GENERAL` |

Client OF paths never throw (spec §1.4.10). Extension APIs may return Result/error types idiomatically per language.

### 13. Experimental isolation

Spec-experimental features (tracking §6, transaction context, isolated API instances, multi-provider, domainScoped drafts) live behind `@experimental` docs and optionally separate import paths (`fireweave/experimental`). Core evaluation must not depend on them. Python OF imports go through an internal compat shim (`openfeature-sdk>=0.10,<0.11`).

### 14. Future adapters

`BackendAdapter` is the extension point. Phase one: `PostHogAdapter`, `InMemoryAdapter`. Future adapters (LaunchDarkly, Statsig, Fireweave-native, etc.) implement the same interface without changing OF public flag APIs. One adapter instance per runtime in phase one.

### 15. Multi-backend

Phase one: **single backend per runtime**. Users who need multi-provider composition use OpenFeature `MultiProvider` (Node) where available — documented as untested on Python. Fireweave does not ship a multi-adapter fan-out in phase one.

### 16. Domain scoping

Providers are **safe to bind to multiple OF domains** (stateless across domains; state lives in the shared runtime). Do **not** declare `domainScoped` (draft/Node-only). Node `initialize(context, domain?)` accepts and ignores `domain`. Document that one runtime should not be shared across conflicting credential sets.

### 17. Shared state

Runtime owns: adapter, config, lifecycle state, optional exposure policy helpers, telemetry sinks. Provider and Client are thin facades. No process-global mutable singleton required (so isolated OF API instances can work later); language OF singletons still apply for `OpenFeature.setProvider` as usual.

### 18. Thread safety

Runtime and adapter MUST be safe for concurrent evaluations on one instance. Document Java ThreadLocal request-context hazard: Fireweave evaluation always passes explicit context; do not rely on PostHog ThreadLocal for OF path. Go client concurrent by design; Node single-threaded + async; Python queue/thread pool.

### 19. After-shutdown

Post-shutdown evaluations return defaults with `AlreadyClosed` (OF `PROVIDER_NOT_READY`; kind preserved in `fireweave.errorKind` metadata). Extension calls fail fast with `AlreadyClosed` (or `Configuration` if shutdown failed hard). Shutdown is idempotent; double-close is a no-op success.

### 20. Default telemetry / PII

Default: **no** Fireweave control-plane telemetry beyond what the adapter emits for flag exposure (PostHog `$feature_flag_called` when enabled). OTel hooks are opt-in. PII: never log API keys; redact `phc_`/`phs_`/`phx_`/`FW_PROJECT_API_KEY` in error messages; do not enable PostHog debug logging by default; evaluation context may contain PII — adapters pass through to PostHog as person properties (caller's responsibility); Fireweave logs must not dump full context at info level. See `evaluation-context.schema.json` redaction guidance.

### 21. Migrations

- Wire contracts (beacon, env vars) stay compatible with `@fireweaveai/deploy-sdk` shapes by re-specification, not code reuse.
- Public Fireweave SDK 0.x may break with semver-minor until 1.0; OF flag getter shapes follow OF stability.
- Adapter isolates PostHog snapshot API; pin PostHog SDK versions (decision brief §3) to absorb `/flags` migration churn.
- Deprecated PostHog per-flag APIs are not used.

### 22. Extending without breaking flags

New Fireweave features land on `FireweaveClient` or additive `flagMetadata` keys under `fireweave.*` namespace. OF resolver signatures never gain Fireweave-only parameters. Optional evaluation options use OF hook hints or FireweaveClient parallel APIs (`evaluateDetailed`) rather than breaking Provider interfaces.

### 23. Side-effect-controlled evaluation

Every evaluation path documents whether it may emit exposure. OF default path: side-effectful (exposure on). Explicit opt-out for pure reads. Payload retrieval must follow PostHog semantics (`getFlagPayload` does not emit) when used for metadata enrichment after a value read.

### 24. Sync vs async adapter surface

Runtime exposes sync evaluation core where possible; Node provider wraps with async. Python implements sync resolvers + optional `*_async`. Go/Java sync with context/cancellation where applicable. Adapter interface documents both; implementations may bridge via async-to-sync only when the language PostHog SDK requires it (Node).

### 25. Testability / InMemoryAdapter

`InMemoryAdapter` implements `BackendAdapter` with fixture-driven flags (Agent E fixtures). Unit/conformance tests bind `FireweaveProvider` to InMemory — no network. Adapter integration tests may use PostHog transport seams (Node `fetch`, Go `Transport`) or stub HTTP servers (Python/Java). Official OF in-memory providers are behavioral oracles, not Fireweave's production test adapter.

## Package naming (working assumptions — company open)

| Ecosystem | Working name | Status |
|---|---|---|
| npm | `@fireweaveai/sdk` (+ optional subpaths) | Scope exists; name needs confirmation |
| PyPI | `fireweave` with extra `fireweave[posthog]` | **Unverified** availability |
| Go | `github.com/FireWeave-HQ/fireweave-sdk/sdks/go` | Requires public repo |
| Maven | `ai.fireweave:sdk` (groupId `ai.fireweave`) | **Unverified** Central namespace |
| License | **MIT** (assumed) | **Company decision / release blocker** |

## Compliance

- OpenFeature spec **v0.8.0** floor
- No AGPL code (`fireweave-data-engine`)
- No proprietary `deploy-sdk` source copy
- DCO assumed for contributions (CLA needs company decision)

## References

- `docs/orchestration/decision-brief.md`
- `docs/research/repository-assessment.md`
- `docs/research/openfeature-compatibility.md`
- `docs/research/posthog-sdk-matrix.md`
- Internal ADR-017 (thin provider strategy) — superseded in-repo packs; decision implemented here
- ADRs 0002–0004, `docs/architecture.md`, `spec/`
