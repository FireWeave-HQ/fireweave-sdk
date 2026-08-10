# Compatibility matrix

Spec version **0.1.0**; OpenFeature specification compliance floor **v0.8.0**. Status date: 2026-08-09.

> **Node is ahead of the other languages.** 2.1 of the Node package removed the direct vendor adapter ([ADR-0006](adr/0006-node-drops-direct-posthog-adapter.md)), adopted "control point" as the product noun ([ADR-0007](adr/0007-control-point-vocabulary.md)), and added Bun/Deno support ([ADR-0008](adr/0008-multi-runtime-support.md)). Python now also exposes control-point vocabulary, `register_target`, and a local (dev) adapter, but still ships the vendor adapter escape hatch. Go and Java still lead with flag vocabulary. That asymmetry is **deliberate and temporary** — each language gets its own pass. Rows below marked *(Node 2.1)* record where the languages currently diverge. **Registry status:** `@fireweaveai/sdk` is published on npm at `0.1.0` and `2.0.0` (`latest` = 2.0.0); **2.1.0 is not published yet**, so an unpinned `npm install` still resolves to 2.0.0. Python, Go, and Java remain unpublished — install those from a checkout ([quickstart.md](quickstart.md)).

> **On the "2.1" wording below.** This release was drafted as 3.0.0 and ships as **2.1.0** (see the CHANGELOG version note); no 3.x ever reached a registry. Rows marked *(Node 2.1)* describe **this** release — the wording is being cleaned up separately so the change is a rename, not a semantic edit buried in a version bump.

## Core matrix

| | Node | Python | Go | Java |
| --- | --- | --- | --- | --- |
| **Package (working name)** | `@fireweaveai/sdk` | `fireweave` | `github.com/FireWeave-HQ/fireweave-sdk/sdks/go` | `ai.fireweave:fireweave-{sdk,openfeature,adapter-posthog,testing}` |
| **Language version** | Node ≥ 20.20 · Bun ≥ 1.2 · Deno ≥ 2.0 | Python ≥ 3.10 | Go 1.25 | Java ≥ 11 |
| **Package version** | `2.1.0` | `0.1.0` | `0.1.0` | `0.1.0-SNAPSHOT` |
| **OpenFeature SDK pin** | `@openfeature/server-sdk` 1.22.0 (peer) | `openfeature-sdk` ≥ 0.10, < 0.11 (**pre-1.0**) | `go-sdk` v1.17.2 | `dev.openfeature:sdk` **1.15.1** (newest published; orchestrator ruling 10) |
| **Vendor SDK pin** | **none** *(Node 2.1 — adapter removed; zero runtime deps)* | `posthog` 7.31.0 (`[posthog]` extra) | `posthog-go` v1.22.0 | **none** — `com.posthog:posthog-server` not yet published; adapter behind `PostHogClientApi` seam |
| **Fireweave remote** (`FireweaveRemoteAdapter`) | ✅ only network adapter | ✅ | ✅ | ✅ |
| **Direct vendor adapter** | ❌ removed *(Node 2.1)* | ✅ escape hatch | ✅ escape hatch | ⚠️ seam only ([posthog.md](posthog.md#java)) |
| **Local (in-process) evaluation** | ❌ none *(Node 2.1 — caching is fw-server's concern; the interface seam is preserved)* | ✅ `secret_key`/`personal_api_key` + `local_evaluation` | ✅ `SecretKey` | ⏳ pending upstream artifact |
| **Local-only mode** | ❌ *(Node 2.1)* | ✅ `only_evaluate_locally` | ✅ `LocalEvaluationOnly` | ⏳ pending upstream |
| **Target registration** (`registerTarget` / `register_target`) | ✅ `/v1/targets/register` | ✅ `/v1/targets/register` | ⏳ planned | ⏳ planned |
| **Product vocabulary** | control points (`client.controlPoints`, `client.flags` retained) *(Node 2.1)* | control points (`client.control_points`, `client.flags` retained) | flags | flags |
| **Local (dev) adapter** | ✅ `FireweaveLocalAdapter` + `makeFireweaveLocalProvider()` *(Node 2.1)* | ✅ `FireweaveLocalAdapter` + `make_fireweave_local_provider()` | ⏳ planned | ⏳ planned |
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

## Web (browser) surface

`@fireweaveai/web-sdk` ([ADR-0009](adr/0009-browser-control-points.md)) is a **fifth binding**, deliberately kept out of the table above: it is a different surface, not a fifth language, and its conformance suite is different in kind (see below).

| | Web |
| --- | --- |
| **Package** | `@fireweaveai/web-sdk` |
| **Version** | `2.1.0` (unpublished) |
| **OpenFeature SDK pin** | `@openfeature/web-sdk` ^1.9.0 (peer) |
| **Runtime deps** | **none** |
| **Fireweave remote** | ✅ only adapter — batch `POST /v1/flags/evaluate`, one call per context |
| **Direct vendor adapter** | ❌ none, structurally — no `posthog-js`, no vendor key shapes accepted |
| **Local (in-process) evaluation** | ❌ **never** — `localEvaluation` is `false` and there is no path that could set it true |
| **Target registration** | ✅ `/v1/targets/register` via `client.identify()` |
| **Product vocabulary** | control points (`client.controlPoints`) |
| **Fireweave extensions** | ✅ releases / exposures / signals / capabilities |
| **Guardrails** | 🧪 stub (`UnsupportedCapability`) |
| **In-memory adapter** | ✅ (+ fault injection) |
| **Conformance** | 10/10 (`contracts/web/`) |

### Surface differences from the server SDKs

These are consequences of the OpenFeature web contract, not gaps:

| | Server | Web |
| --- | --- | --- |
| `controlPoints.*` | `Promise`-returning | **synchronous** — reads happen in render paths, where awaiting is not an option |
| Evaluation source | per-call backend round trip | prefetched cache, refreshed on `initialize` and `setContext` |
| Lifecycle states | UNINITIALIZED → INITIALIZING → READY → SHUTDOWN | adds **STALE** — prefetch did not complete, so reads are defaults. Collapsing this into READY would make a timed-out boot indistinguishable from a rollout sitting at 0% |
| Telemetry flush | shutdown hook | `visibilitychange` → hidden and `pagehide`, over `keepalive`/`sendBeacon` — a tab gets no shutdown hook |
| Config source | env (`readEnv`) | **explicit constructor options only** — the SDK reads no environment at all |

### Tested on Bun only

`@fireweaveai/web-sdk` targets **browsers**. It ships no server entry point, reads no environment, and imports no runtime built-ins, so Node and Deno are not target runtimes — running the suite on them would assert a property no user depends on. **Bun** runs the unit suite and the conformance harness; **happy-dom** supplies the DOM (preloaded via `bunfig.toml`).

The DOM is real enough to matter: `pagehide`, `visibilitychange → hidden`, listener detach, and the `keepalive` unload request are all dispatched and asserted, not stubbed.

**Coverage boundary (stated, not glossed):** happy-dom is a DOM, not a browser. bfcache restore, beacon size limits, and whether a request actually leaves the socket during unload are browser behaviours no headless DOM can assert. If that path proves fragile in practice, the escalation is a small Playwright suite over exactly those invariants.

## Numeric limitations (pre-declared)

| Language | Limitation | Behavior |
| --- | --- | --- |
| Node | Single OpenFeature `number` resolver; IEEE-754 double | Integers beyond ±(2^53−1) are not lossless — 2 fixture skips |
| Java | OpenFeature integer resolver is 32-bit `int` | Integral flag values outside `Integer` range resolve `TYPE_MISMATCH` + default (never silent truncation) — 1 fixture skip |
| All | Canonical JSON numbers | Cross-language integer reliability is guaranteed within ±(2^53−1) |

## Backend/adapter behavior caveats

| Area | Caveat |
| --- | --- |
| Node has no cache **(Node 2.1)** | Every evaluation is a fw-server round trip. `reason: STALE` / `fireweave.fromCache` can only originate upstream; `capabilities.get().runtime.features.localEvaluation` is `false` |
| Node default host allowlist **(Node 2.1)** | `DEFAULT_ALLOWED_HOSTS` lists Fireweave hosts + loopback, not vendor hosts. Still exported under the same name, so code composing on it silently stops permitting the old endpoints — intended; see [migration](migration.md#behavior-worth-re-checking) |
| Java remote cache **[vendor-specific]** | The vendor Java SDK caches per-user remote flag results up to ~5 min and keeps last-good local definitions; stale serves are labeled (`reason: STALE`, `fireweave.fromCache`), runtime shows `STALE` |
| Exposure dedup cache sizes **[vendor-specific]** | Vendor LRU sizes differ across SDKs; Fireweave does not equalize them in phase one |
| Polling default | Fireweave normalizes definitions polling toward 30 s where the vendor SDK allows override (not applicable to Node 2.1) |
| Go capture queue | posthog-go can drop telemetry on queue overflow; capture failures map to extension errors, evaluation is unaffected |
| `$`-prefixed context attributes | Passed through as backend system directives, not person properties; stripped from telemetry context views |
| Node fault-conformance backend **(Node 2.1)** | The 9 `contracts/faults/*` fixtures run through `FireweaveRemoteAdapter` against `/v1/flags/evaluate`; the other languages still drive the legacy vendor routes. Same assertions, different transport |

## Known gaps

Pre-release; tracked for arbitration/1.0.

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
