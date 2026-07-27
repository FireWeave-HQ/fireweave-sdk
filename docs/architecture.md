# Fireweave Polyglot SDK — Architecture

**Status:** Phase-one design (2026-07-27)  
**ADRs:** [0001](adr/0001-sdk-architecture.md) · [0002](adr/0002-posthog-adapter.md) · [0003](adr/0003-openfeature-boundary.md) · [0004](adr/0004-server-first.md)  
**Schemas:** [`spec/`](../spec/) (v0.1.0)

## 1. Goal

Open-source, OpenFeature-compatible, server-first SDK for Node, Python, Go, and Java. One shared architectural pattern per language: **FireweaveProvider + FireweaveClient → FireweaveRuntime → BackendAdapter**. Phase-one adapter: PostHog (official SDKs). Test adapter: InMemory. No custom flag evaluator. No PostHog types in public APIs. Side-effect-controlled evaluation.

This repo implements internal ADR-017's thin-provider decision and **supersedes** its in-repo language packs.

## 2. Layers

```
┌─────────────────────────────────────────────────────────────┐
│  Application                                                 │
│  OpenFeature Client          FireweaveClient                 │
└─────────────┬───────────────────────────┬───────────────────┘
              │                           │
┌─────────────▼───────────────────────────▼───────────────────┐
│  FireweaveProvider (OF)      Extension API façade            │
│         └──────────── FireweaveRuntime ────────────┘         │
│              lifecycle · options · capabilities               │
└─────────────────────────────┬───────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────┐
│  BackendAdapter (interface)                                  │
│  ┌─────────────────────┐  ┌──────────────────────────────┐  │
│  │ PostHogAdapter      │  │ InMemoryAdapter (tests)      │  │
│  │ wraps official SDK  │  │ fixture-driven decisions     │  │
│  └─────────────────────┘  └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                    PostHog /flags · definitions
                    (or none for InMemory)
```

| Layer | Responsibility |
|---|---|
| OpenFeature Client | Spec evaluation API, hooks, domains, events, never-throw getters |
| FireweaveProvider | OF `FeatureProvider`; maps context/errors; delegates to runtime |
| FireweaveClient | Releases, exposures helpers, signals, guardrails, capabilities, telemetry, detailed eval |
| FireweaveRuntime | Shared init/shutdown, config, adapter ownership, exposure policy |
| BackendAdapter | Vendor-neutral evaluate/capture/lifecycle; PostHog types stop here |
| Spec / contracts | Canonical JSON Schema (`spec/`); fixtures owned by Agent E (`contracts/`) |

## 3. Lifecycle state machine

```
                     construct()
                          │
                          ▼
                   ┌──────────────┐
          ┌────────│ UNINITIALIZED│
          │        └──────┬───────┘
          │               │ init()
          │               ▼
          │        ┌──────────────┐
          │        │ INITIALIZING │──────── fatal config/auth ──► FATAL
          │        └──────┬───────┘                                │
          │               │ success                                │
          │               ▼                                        │
          │        ┌──────────────┐     poll/transport degradation │
          │        │    READY     │────────► STALE / ERROR         │
          │        └──────┬───────┘◄──────── recovery ─────┘       │
          │               │                                        │
          │               │ shutdown()                             │
          │               ▼                                        │
          │        ┌──────────────┐                                │
          └───────►│   SHUTDOWN   │◄───────────────────────────────┘
                   └──────────────┘
                   (idempotent; terminal for this instance)
```

- OF status mapping: UNINITIALIZED/INITIALIZING → `NOT_READY`; READY → `READY`; STALE → `STALE`; ERROR → `ERROR`; FATAL → `FATAL`; SHUTDOWN → `NOT_READY`.
- SDK synthesizes PROVIDER_READY/ERROR from initialize (shipped OF behavior).
- Runtime emits CONFIG_CHANGED when definitions refresh meaningfully.

## 4. Package boundaries

Working names (company-open where noted):

| Language | Package | Notes |
|---|---|---|
| Node | `@fireweaveai/sdk` | Peer: `@openfeature/server-sdk`. Optional dependency / subpath for PostHog adapter. |
| Python | `fireweave` | Extra: `fireweave[posthog]` pulls `posthog`. OF: `openfeature-sdk>=0.10,<0.11`. |
| Go | `github.com/FireWeave-HQ/fireweave-sdk/sdks/go` | Module in `sdks/go`. |
| Java | `ai.fireweave:sdk` | GroupId **`ai.fireweave`** (Central verification open). PostHog via `com.posthog:posthog-server`. |

Layout (implementation agents; not created by Agent D):

```
sdks/node/   sdks/python/   sdks/go/   sdks/java/
spec/        contracts/     test-server/   docs/
```

License assumption: **MIT** (ratify before publish).

## 5. Canonical data model

Schemas in `spec/` (draft 2020-12), version **0.1.0**:

| Schema | Role |
|---|---|
| `evaluation-context` | Identity + attributes + reserved `fireweave.*` keys; merge/precedence; bounds; PII |
| `decision` | Flag decision: value, variant, reason, error, metadata, exposure |
| `release-context` | Rollout/release identifiers (typed ULIDs), harness hints |
| `signal` | Telemetry/signal envelopes for release safety |
| `capabilities` | Static package + runtime adapter capability matrix |
| `errors` | Fireweave error taxonomy → OF mapping |
| `fireweave-sdk` | Root meta-schema bundling version + component refs |

Typed ID prefixes (parity with platform): `chg_`, `stmp_`, `sfc_`, rollout ids as documented in release-context.

## 6. Public API sketch

Names are illustrative; language idioms apply (camelCase / snake_case / exported Go).

### 6.1 Construction

```
FireweaveRuntime.builder()
  .apiKey(phc_...)
  .secretKey(phs_...)?          // local eval
  .host(url)?
  .adapter("posthog" | "inmemory" | BackendAdapter)
  .exposurePolicy({ defaultSend: true })
  .shutdownTimeout(10s)
  .build()

FireweaveProvider.from(runtime)   // register with OpenFeature
FireweaveClient.from(runtime)     // extensions
```

### 6.2 Flags (via OpenFeature)

```
client.getBooleanValue(flag, default, context)
client.getBooleanDetails(...)
// string / number|int|float / object likewise
```

Provider resolvers → `runtime.evaluate(flag, type, default, context, options) → Decision`.

### 6.3 Detailed / side-effect control (FireweaveClient)

```
client.flags.evaluate(flag, type, default, context, { sendExposure: false }) → Decision
client.flags.evaluateMany(keys, context, options) → map<key, Decision>
```

### 6.4 Releases

```
client.releases.attest(releaseContext) → result     // boot beacon / stamp liveness
client.releases.current() → ReleaseContext | null
```

Wire-compatible with `FW_ATTEST_URL` / `FW_PROJECT_API_KEY` (re-specified; not copied from deploy-sdk).

### 6.5 Exposures

```
client.exposures.track(flag, decision, context)?   // explicit; rare — prefer OF path
client.exposures.setPolicy(policy)
```

Normally PostHog SDK emits `$feature_flag_called` through adapter accessors.

### 6.6 Signals

```
client.signals.emit(signal)   // adoption/guard metrics observations
```

### 6.7 Guardrails

```
client.guardrails.evaluate(rules, observations) → allow | deny | hold
```

Phase one may ship types + no-op/local evaluation only; server-side ramp remains fw-server.

### 6.8 Capabilities

```
client.capabilities() → Capabilities  // static ∪ runtime
```

### 6.9 Telemetry

```
client.telemetry.configure({ otel: true | hooks })  // opt-in
```

Default: off (aside from PostHog exposure when enabled).

## 7. Evaluation path (happy path)

1. OF merges context (API→transaction→client→invocation→before-hooks).
2. Provider validates targetingKey; maps to canonical `EvaluationContext`.
3. Runtime checks lifecycle (else default + NOT_READY).
4. Adapter `evaluateFlags(snapshot)` with person/group properties.
5. Extract typed value; coerce or TYPE_MISMATCH → default.
6. Build `Decision` (reason/metadata/quota); map errors.
7. Return OF `ResolutionDetails` / `ProviderEvaluation`.
8. Exposure per policy (side effect inside adapter accessors when enabled).

## 8. Conformance & ownership

- **Agent D (this doc / ADRs / spec):** architecture and schemas only.
- **Agent E:** `contracts/`, fixtures, test-server, error taxonomy instances.
- **Agents F–I:** language implementations against spec + contracts.
- OF Appendix B Gherkin + Fireweave fixtures; no flagd requirement.

## 9. Open company decisions

1. License ratification (MIT assumed).
2. Final package names / PyPI availability / Maven Central `ai.fireweave`.
3. CLA vs DCO (DCO assumed).
4. Long-term relationship of `@fireweaveai/deploy-sdk` to this SDK.
5. Publication authorization (gated).

## 10. Non-goals (phase one)

Browser/mobile SDKs; custom evaluator; multi-adapter fan-out; depending on PostHog OF providers; AGPL or proprietary source reuse; publishing to registries.
