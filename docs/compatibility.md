# Compatibility matrix

Spec version **0.1.0**; OpenFeature specification compliance floor **v0.8.0**. Status date: 2026-07-27. All packages **unpublished** (pre-release; install from checkout — [quickstart.md](quickstart.md)).

## Core matrix

| | Node | Python | Go | Java |
| --- | --- | --- | --- | --- |
| **Package (working name)** | `@fireweaveai/sdk` | `fireweave` | `github.com/FireWeave-HQ/fireweave-sdk/sdks/go` | `ai.fireweave:fireweave-{sdk,openfeature,adapter-posthog,testing}` |
| **Language version** | Node ≥ 20.20 | Python ≥ 3.10 | Go 1.25 | Java ≥ 11 |
| **OpenFeature SDK pin** | `@openfeature/server-sdk` 1.22.0 (peer) | `openfeature-sdk` ≥ 0.10, < 0.11 (**pre-1.0**) | `go-sdk` v1.17.2 | `dev.openfeature:sdk` **1.15.1** (newest published; orchestrator ruling 10) |
| **PostHog SDK pin** | `posthog-node` 5.46.1 (optional peer) | `posthog` 7.31.0 (`[posthog]` extra) | `posthog-go` v1.22.0 | **none** — seam only / not production-ready (no published PostHog server SDK; see [posthog.md](posthog.md#java)) |
| **Remote evaluation** (`phc_`) | ✅ | ✅ | ✅ | ⚠️ **seam only** — injected `PostHogClientApi` stub/tests; `PostHogAdapter.create(config)` → `UnsupportedCapability` (API keys alone cannot create a live client) |
| **Local evaluation** (`phs_`/`phx_`) | ✅ `secretApiKey` | ✅ `secret_key`/`personal_api_key` + `local_evaluation` | ✅ `SecretKey` | ❌ unsupported until upstream server SDK |
| **Local-only mode** | ✅ `onlyEvaluateLocally` | ✅ `only_evaluate_locally` | ✅ `LocalEvaluationOnly` | ❌ unsupported until upstream server SDK |
| **Structured (object) flags** | ✅ | ✅ | ✅ | ✅ |
| **Multivariate variants** | ✅ | ✅ | ✅ | ✅ |
| **Groups / group properties** | ✅ plain `groups` attribute | ✅ `fireweave.groups` / `fireweave.groupProperties` | ✅ plain `groups` / `groupProperties` attributes | ✅ context-builder `.group()` API |
| **Flag payloads** (`fireweave.payload` metadata) | ✅ provider `includePayload` | ✅ `include_payload` | ✅ `fireweave.WithIncludePayload(ctx)` | ✅ `EvaluationOptions` |
| **Exposure events** | Explicit API; vendor `$feature_flag_called` disabled (side-effect-free reads) | Explicit API; vendor events disabled | Explicit API + opt-in vendor events (`SendExposureEvents`); `$fw_*` telemetry | Explicit API + `EvaluationOptions.sendExposure` (default on) via seam/`InMemoryAdapter` |
| **OpenFeature tracking (spec §6)** | ⏳ planned | ⏳ planned | ⏳ planned | ⏳ planned |
| **Fireweave extensions** (releases / exposures / signals / capabilities) | ✅ | ✅ | ✅ | ✅ |
| **Guardrails** | 🧪 stub (`UnsupportedCapability`) | 🧪 stub | 🧪 stub | 🧪 stub |
| **In-memory adapter** | ✅ (+ typed fault injection) | ✅ | ✅ | ✅ (`fireweave-testing`, + fault simulation) |
| **Async surface** | native async | sync core + `fireweave.aio` | sync + `context.Context` | sync |
| **Conformance (65 fixtures)** | 63/65 (2 numeric skips) | 65/65 | 65/65 | 64/65 (1 numeric skip: `eval-int-beyond-safe-integer`) |

✅ works · ⚠️ works with caveat · ⏳ planned/blocked · 🧪 experimental stub

All conformance skips are **pre-declared** in the fixtures themselves (`skipped-with-documented-limitation`) — there are no silent skips and no failures.

## Numeric limitations (pre-declared)

| Language | Limitation | Behavior |
| --- | --- | --- |
| Node | Single OpenFeature `number` resolver; IEEE-754 double | Integers beyond ±(2^53−1) are not lossless — 2 fixture skips |
| Java | OpenFeature integer resolver is 32-bit `int` | Integral flag values outside `Integer` range resolve `TYPE_MISMATCH` + default (never silent truncation) — 1 fixture skip |
| All | Canonical JSON numbers | Cross-language integer reliability is guaranteed within ±(2^53−1) |

## Backend/adapter behavior caveats

| Area | Caveat |
| --- | --- |
| Java PostHog **[not production-ready]** | Seam only: `PostHogClientApi` injection for tests/stubs. No live create-from-config path until PostHog publishes a server SDK. Prefer `InMemoryAdapter` for Java apps today. |
| Java remote cache **[PostHog-specific, seam]** | When an injected client returns aged snapshots, stale serves are labeled (`reason: STALE`, `fireweave.fromCache`), runtime shows `STALE` |
| Exposure dedup cache sizes **[PostHog-specific]** | Vendor LRU sizes differ across SDKs where a real vendor client exists; Fireweave does not equalize them in phase one |
| Polling default | Fireweave normalizes definitions polling toward 30 s where the vendor SDK allows override |
| Go capture queue | posthog-go can drop telemetry on queue overflow; capture failures map to extension errors, flag evaluation is unaffected |
| `$`-prefixed context attributes | Passed through as PostHog system directives, not person properties; stripped from telemetry context views |

## Known gaps (pre-release; tracked for arbitration/1.0)

1. **Groups context spelling differs per language** (see matrix row). The ratified spec names `fireweave.groups`/`fireweave.groupProperties`; today only Python accepts that spelling — Node currently rejects all `fireweave.*` keys and uses plain `groups`. Portable code should isolate group-context construction per language ([identity.md](identity.md#groups)).
2. **`releases.setContext` required fields differ**: Node requires non-empty `stampIds`; Python/Go require `rolloutId`; Java requires a non-null context. Supply both and you're portable ([extensions.md](extensions.md#releases)).
3. **Fireweave-native detailed evaluation naming differs**: Python `client.flags.get_details(...)`, Java `client.evaluate(...)`, Node `runtime.evaluate(...)`, Go `runtime.Evaluate(...)` (the architecture sketch's `client.flags.evaluate` shape exists only in Python).
4. **Release/signal delivery**: Go (and Java via the adapter seam) deliver release transitions/signals to the backend telemetry sink; Node/Python currently record them in-process only.
5. **`capabilities.get` return shape**: structured static∪runtime matrix in Node/Java; canonical name list in Python/Go.
6. **Java PostHog is seam only / not production-ready** (ruling 10 / RB-3): no published `com.posthog:posthog-server`; `PostHogAdapter.create(config)` → `UnsupportedCapability` with guidance to inject `PostHogClientApi` or use `InMemoryAdapter`. Docs/examples never imply API-key-only live PostHog construction for Java.
7. **Readiness gating of extension calls**: Go/Java gate every extension call on runtime state (NotReady/AlreadyClosed); Node/Python accept records pre-ready and surface backend state at flush time.

## OpenFeature feature support (per ADR-0003)

| OpenFeature feature | Status |
| --- | --- |
| Typed resolvers, detailed resolution, flagMetadata | ✅ all languages |
| Provider lifecycle (initialize/shutdown), SDK-synthesized READY/ERROR | ✅ |
| Hooks (user-registered) | ✅ — provider ships no hooks of its own |
| Domains / named clients | ✅ (providers are domain-safe; `domainScoped` not declared) |
| Events (READY / ERROR / STALE / CONFIG_CHANGED) | ✅ as supported by each language's OF SDK |
| Transaction context (§3.3) | 🧪 usable where the OF SDK ships it; no Fireweave dependency |
| Multi-provider | Compatible where OpenFeature ships it (Node); **untested on Python** |
| Tracking (§6) | ⏳ planned |

## Server-only scope

Phase one targets trusted server runtimes exclusively (ADR-0004): no browser (`@openfeature/web-sdk`, `posthog-js`), no mobile, no edge workers unless they can hold secrets safely. Secret keys (`phs_`/`phx_`) must never reach a frontend bundle.
