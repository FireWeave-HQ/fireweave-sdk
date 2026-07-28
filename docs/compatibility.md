# Compatibility matrix

Spec version **0.1.0**; OpenFeature specification compliance floor **v0.8.0**. Status date: 2026-07-27. All packages **unpublished** (pre-release; install from checkout — [quickstart.md](quickstart.md)).

## Core matrix

| | Node | Python | Go | Java |
| --- | --- | --- | --- | --- |
| **Package (working name)** | `@fireweaveai/sdk` | `fireweave` | `github.com/FireWeave-HQ/fireweave-sdk/sdks/go` | `ai.fireweave:fireweave-{sdk,openfeature,adapter-posthog,testing}` |
| **Language version** | Node ≥ 20.20 | Python ≥ 3.10 | Go 1.25 | Java ≥ 11 |
| **OpenFeature SDK pin** | `@openfeature/server-sdk` 1.22.0 (peer) | `openfeature-sdk` ≥ 0.10, < 0.11 (**pre-1.0**) | `go-sdk` v1.17.2 | `dev.openfeature:sdk` **1.15.1** (newest published; orchestrator ruling 10) |
| **PostHog SDK pin** | `posthog-node` 5.46.1 (optional peer) | `posthog` 7.31.0 (`[posthog]` extra) | `posthog-go` v1.22.0 | **none** — `com.posthog:posthog-server` not yet published; adapter behind `PostHogClientApi` seam |
| **Remote evaluation** (`phc_`) | ✅ | ✅ | ✅ | ⚠️ injected `PostHogClientApi` only ([posthog.md](posthog.md#java)) |
| **Local evaluation** (`phs_`/`phx_`) | ✅ `secretApiKey` | ✅ `secret_key`/`personal_api_key` + `local_evaluation` | ✅ `SecretKey` | ⏳ pending upstream artifact |
| **Local-only mode** | ✅ `onlyEvaluateLocally` | ✅ `only_evaluate_locally` | ✅ `LocalEvaluationOnly` | ⏳ pending upstream |
| **Structured (object) flags** | ✅ | ✅ | ✅ | ✅ |
| **Multivariate variants** | ✅ | ✅ | ✅ | ✅ |
| **Groups / group properties** | ✅ canonical `fireweave.groups` / `fireweave.groupProperties` + plain `groups` / `groupProperties` alias (rulings 12–14, 19) | ✅ same | ✅ same | ✅ builder `.group()` + canonical/alias attributes |
| **Flag payloads** (`fireweave.payload` metadata) | ✅ provider `includePayload` | ✅ `include_payload` | ✅ `fireweave.WithIncludePayload(ctx)` / `Flags().Evaluate(..., IncludePayload)` | ✅ `EvaluationOptions` |
| **Exposure events** | Explicit `exposures.*`; evaluate opt-in via `sendExposure: true` (default false; ruling 20); vendor `$feature_flag_called` suppressed on local path (RB-2) | Explicit `exposures.*`; evaluate opt-in (`send_exposure=True`, default false); OF-path side-effect-free | Explicit `exposures.*` + opt-in (`SendExposureEvents` / per-call `SendExposure`, default false) | Explicit `exposures.*` + evaluate opt-in (`sendExposure(true)`, default false); Fireweave-owned via adapter seam (RB-3) |
| **OpenFeature tracking (spec §6)** | ⏳ planned | ⏳ planned | ⏳ planned | ⏳ planned |
| **Fireweave extensions** (releases / exposures / signals / capabilities) | ✅ | ✅ | ✅ | ✅ |
| **Guardrails** | 🧪 stub (`UnsupportedCapability`) | 🧪 stub | 🧪 stub | 🧪 stub |
| **In-memory adapter** | ✅ (+ typed fault injection) | ✅ | ✅ | ✅ (`fireweave-testing`, + fault simulation) |
| **Async surface** | native async | sync core + `fireweave.aio` | sync + `context.Context` | sync |
| **Conformance (65 fixtures)** | 63/65 | 65/65 | 65/65 | 64/65 |

✅ works · ⚠️ works with caveat · ⏳ planned/blocked · 🧪 experimental stub

All conformance skips are **pre-declared** in the fixtures themselves (`skipped-with-documented-limitation`) — there are no silent skips and no failures.

**Skip IDs (pre-declared):**

| Language | Fixture ID | Limitation |
| --- | --- | --- |
| Node | `eval-int-beyond-safe-integer` | IEEE-754 double; integers beyond ±(2^53−1) not lossless |
| Node | *(second numeric skip in suite)* | Same Number resolver constraint — see numeric table |
| Java | `eval-int-beyond-safe-integer` (or integer-range skip) | OF integer resolver is 32-bit `int` → `TYPE_MISMATCH` + default outside range |

## Numeric limitations (pre-declared)

| Language | Limitation | Behavior |
| --- | --- | --- |
| Node | Single OpenFeature `number` resolver; IEEE-754 double | Integers beyond ±(2^53−1) are not lossless — 2 fixture skips |
| Java | OpenFeature integer resolver is 32-bit `int` | Integral flag values outside `Integer` range resolve `TYPE_MISMATCH` + default (never silent truncation) — 1 fixture skip |
| All | Canonical JSON numbers | Cross-language integer reliability is guaranteed within ±(2^53−1) |

## Backend/adapter behavior caveats

| Area | Caveat |
| --- | --- |
| Java remote cache **[PostHog-specific]** | The vendor Java SDK caches per-user remote flag results up to ~5 min and keeps last-good local definitions; stale serves are labeled (`reason: STALE`, `fireweave.fromCache`), runtime shows `STALE` |
| Exposure dedup cache sizes **[PostHog-specific]** | Vendor LRU sizes differ across SDKs (Node ~50k vs Java ~1k entries); Fireweave does not equalize them in phase one |
| Polling default | Fireweave normalizes definitions polling toward 30 s where the vendor SDK allows override |
| Go capture queue | posthog-go can drop telemetry on queue overflow; capture failures map to extension errors, flag evaluation is unaffected |
| `$`-prefixed context attributes | Passed through as PostHog system directives, not person properties; stripped from telemetry context views |

## Known gaps (pre-release; tracked for arbitration/1.0)

1. **Java PostHog binding** pending upstream publication (ruling 10 / adversarial RB-3) — `PostHogAdapter.create(config)` → `UnsupportedCapability`; production use requires an injected `PostHogClientApi` seam / offline stub. No published `com.posthog:posthog-server` artifact yet.
2. **Release/signal delivery skew:** Go (and Java via the adapter seam) deliver release transitions/signals to the backend telemetry sink; Node/Python may record some paths in-process only — check `capabilities.get().runtime.features` and language docs.
3. **ADR §6/§23 "default emit on OF evaluation"** remains deferred: phase-one portable default is side-effect-free evaluate (ruling 20) + explicit `exposures.*` / opt-in `sendExposure`; full emit-once-on-OF is not phase-one scope.

**Closed since Phase 5 / Phase 6 (do not treat as current gaps):**

- `fireweave.groups` / `fireweave.groupProperties` carve-out — implemented in all four languages (+ plain alias per ruling 19).
- `capabilities.get` structured static∪runtime matrix — all four (Python/Go also expose name-list sugar: `names()` / `Operations()`).
- Extension lifecycle gating (ruling 17) — all four.
- Fireweave-native Decision API without runtime reach-in — Python `client.flags.evaluate` / `get_details`; Go `client.Flags().Evaluate`; Java `client.evaluate(...)`. Node detailed eval surface is owned by the Node agent (ruling 16 residual if still `runtime.evaluate` only).
- Host allowlist default-on + Node Internal fixed messages — see [security findings disposition](security/findings-disposition.md).
- RB-1 / RB-2 (Node hybrid local serve + vendor `$feature_flag_called` suppression on local path) — closed in Node adapter.
- Adversarial H-2 (Node stamp/change ULID validation) — closed.
- Adversarial H-4 / ruling 20 (evaluate exposure default false) — Node / Python / Go / Java aligned; opt-in emits Fireweave-owned exposure.
- Adversarial H-7 (Java `evaluationContexts` builder) — removed from `EvaluationContext`.

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
