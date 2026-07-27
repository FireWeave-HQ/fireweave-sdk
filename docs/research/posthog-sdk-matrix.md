# PostHog Server-Side SDK Capability Matrix (Node / Python / Go / Java)

**Research date: 2026-07-27.** All facts below were verified against posthog.com/docs, the official SDK repositories, and the npm/PyPI/Maven/GitHub registries on this date unless marked **UNVERIFIED**. This document informs the Fireweave PostHog adapter design; it contains no implementation code.

Primary sources checked:

- https://posthog.com/docs/libraries/node
- https://posthog.com/docs/libraries/python
- https://posthog.com/docs/libraries/go
- https://posthog.com/docs/libraries/java
- https://posthog.com/docs/feature-flags/local-evaluation
- https://posthog.com/docs/api/flags
- https://posthog.com/docs/feature-flags/cutting-costs (quota limiting)
- https://posthog.com/docs/feature-flags/installation/openfeature (Python provider)
- https://posthog.com/docs/feature-flags/installation/openfeature-js (JS providers)
- https://github.com/PostHog/posthog-js (monorepo; `packages/node` = posthog-node v5, `packages/core` = `@posthog/core`)
- https://github.com/PostHog/posthog-python (`posthog/client.py`)
- https://github.com/PostHog/posthog-go (`config.go`)
- https://github.com/PostHog/posthog-android (monorepo; `posthog-server` module = the current Java/JVM server SDK; confirmed via the `com.posthog:posthog-server` 2.9.0 POM `<scm>` on Maven Central)
- Registries: registry.npmjs.org, pypi.org, repo1.maven.org, api.github.com

---

## 0. Executive summary

- **All four SDKs are current, actively maintained, MIT-licensed, and support both remote evaluation (`/flags?v=2`) and local evaluation** (background polling of flag definitions with a secret key).
- **PostHog has converged all four server SDKs on a new "evaluate once, read from snapshot" API** (`evaluateFlags()` / `evaluate_flags()` / `EvaluateFlags()`), deprecating the per-flag calls (`getFeatureFlag`, `isFeatureEnabled`, `getFeatureFlagPayload`, `sendFeatureFlags: true`). The legacy calls still work "during the migration period" but are documented as deprecated in Node, Python, Go, and Java docs. The Fireweave adapter should target the snapshot API.
- **The Java SDK changed identity**: the current SDK is `com.posthog:posthog-server` (2.x, Kotlin, lives in the `PostHog/posthog-android` monorepo), *not* the old `com.posthog.java:posthog` 1.x library. The new SDK supports local evaluation; the old one did not.
- **Official PostHog OpenFeature providers exist only for Node (`@posthog/openfeature-node-provider` 0.1.0, published 2026-07-06) and Python (`openfeature-provider-posthog` 0.1.20)** — both pre-1.0 and very new. There is no official Go or Java provider (only a stale third-party Go provider). Recommendation for all four languages: **wrap the official PostHog SDK directly** (option b). Justification in §2.
- **Credentials**: project API key `phc_...` (public) for remote evaluation and capture; a secret key for local evaluation — either the legacy personal API key `phx_...` or the newer **Feature Flags Secure API Key** (`phs_...`, project-scoped), which PostHog now recommends and which Node (`secretKey`) and Go (`SecretKey`) expose as first-class options.

---

## 1. Current versions and pinning recommendation (checked 2026-07-27)

| Language | Package | Latest version | License | Notes |
| --- | --- | --- | --- | --- |
| Node | `posthog-node` (npm) | **5.46.1** | MIT | Engines: `node ^20.20.0 \|\| >=22.22.0`. Dep: `@posthog/core ^1.45.1`. **Peer dep: `rxjs ^7.0.0`** |
| Python | `posthog` (PyPI) | **7.31.0** | MIT | Requires Python ≥ 3.10 (7.x). Python 3.9 users must pin `posthog<7` (6.9.3 final 6.x) |
| Go | `github.com/posthog/posthog-go` | **v1.22.0** (released 2026-07-23) | MIT | Repo pushed 2026-07-23 |
| Java | `com.posthog:posthog-server` (Maven Central) | **2.9.0** (metadata lastUpdated 2026-07-22) | MIT | Depends on `com.posthog:posthog` 6.27.0 (shared core), Kotlin stdlib 2.1.10, Gson 2.10.1, OkHttp 4.12.0 |
| Node OF provider | `@posthog/openfeature-node-provider` | 0.1.0 (created 2026-07-06) | MIT | Pre-1.0, days–weeks old |
| Python OF provider | `openfeature-provider-posthog` | 0.1.20 | MIT | Pre-1.0 |
| Go OF provider | none official; `dhaus67/openfeature-posthog-go` v0.1.2 | Apache-2.0 | Third-party; pins ancient `posthog-go v1.2.24`; last meaningful activity 2024 |
| Java OF provider | **none found** (openfeature.dev ecosystem + PostHog docs) | — | — |

**Pinning recommendation:** pin exact versions in the adapter (`posthog-node@5.46.1`, `posthog==7.31.0`, `posthog-go v1.22.0`, `posthog-server:2.9.0`) with a caret/compatible-range CI job that tests the next minor before bumping. Rationale: the flag API surface is mid-migration (deprecated legacy methods, new snapshot API added over the last months); minor releases have been landing API additions weekly (Node ships several patch releases per week). Do not float majors. The snapshot API (`evaluateFlags`) is recent — verify the minimum version supporting it per SDK before setting a floor. **UNVERIFIED: exact first version of `evaluateFlags` in each SDK** (not needed if you pin latest).

---

## 2. Recommendation per language: wrap the official PostHog SDK directly (option b, all four languages)

| Language | Recommendation | Why not the OpenFeature provider? |
| --- | --- | --- |
| Node | **(b) wrap `posthog-node`** | `@posthog/openfeature-node-provider` is 0.1.0, published 2026-07-06 — weeks old, pre-1.0, no stability guarantee. It also layers OpenFeature's typed-getter model over the SDK, hiding the `evaluateFlags()` snapshot, `onlyEvaluateLocally`, evaluation-context tags, and lifecycle controls Fireweave needs. |
| Python | **(b) wrap `posthog` SDK** | `openfeature-provider-posthog` (0.1.20) is official but pre-1.0. It maps `targeting_key`→distinct_id and attributes→person properties, but Fireweave already defines its own OpenFeature-compatible surface; delegating to PostHog's provider would stack two provider layers and forfeit control of `$feature_flag_called` emission, snapshot semantics, and error taxonomy. |
| Go | **(b) wrap `posthog-go`** | No official provider. The community provider (`dhaus67/openfeature-posthog-go`) is stale (2024, pinned `posthog-go v1.2.24`, remote-only, pre-snapshot API). Unsuitable. |
| Java | **(b) wrap `posthog-server`** | No provider exists at all. |

Why (b) over the other options everywhere:

- **(a) official provider**: only exists for 2 of 4 languages, both pre-1.0. Using it in Node/Python and the raw SDK in Go/Java would give Fireweave two different behavioral stacks per backend. A single "wrap the official SDK" pattern keeps cross-language semantics as uniform as PostHog's own SDKs allow.
- **(c) direct HTTP**: violates the project constraint (Fireweave must not reimplement local evaluation, caching, batching, retries, transport) — the `/flags` API is easy, but local evaluation, cohort matching, definition polling, `$feature_flag_called` dedup, and capture batching are exactly the machinery we must not rebuild.
- **(d) route through a Fireweave service**: doesn't exist yet; adds a network hop and operational surface for v1.
- **(b) preserves everything Fireweave needs**: full evaluation semantics (snapshot, payloads, multivariate variants), lifecycle control (init/flush/shutdown), testability (see §9), and room to attach Fireweave metadata around the SDK calls. PostHog types stay behind the adapter boundary — the SDKs return plain booleans/strings/JSON that are easy to convert to Fireweave's public types.

One caveat: the SDKs' *snapshot* objects (`FeatureFlagEvaluations` etc.) are PostHog types; the adapter must unwrap them into Fireweave types at the boundary and never expose them.

---

## 3. Feature-flag API surface (capability matrix)

Legacy per-flag methods exist in all four SDKs but are **documented as deprecated** ("still work during the migration period... Prefer `evaluateFlags()` for new code" — stated verbatim in all four language docs). Matrix shows both.

| Capability | Node (`posthog-node` 5.x) | Python (`posthog` 7.x) | Go (`posthog-go` 1.22) | Java (`posthog-server` 2.9) |
| --- | --- | --- | --- | --- |
| Snapshot evaluation (current API) | `await client.evaluateFlags(distinctId, options?)` → `FeatureFlagEvaluations` | `posthog.evaluate_flags(distinct_id, ...)` → snapshot | `client.EvaluateFlags(posthog.EvaluateFlagsPayload{DistinctId: ...})` → `(flags, err)` | `posthog.evaluateFlags(distinctId, PostHogEvaluateFlagsOptions?)` → `PostHogFeatureFlagEvaluations` |
| Boolean check | `flags.isEnabled('key')` | `flags.is_enabled("key")` | `flags.IsEnabled("key")` | `flags.isEnabled("key")` |
| Variant / value | `flags.getFlag('key')` → variant string \| `true` \| `false` \| `undefined` (flag not returned) | `flags.get_flag("key")` → str \| `True` \| `False` \| `None` | `flags.GetFlag("key")` → variant string \| `true` \| `false` \| `nil` | `flags.getFlag("key")` → `Object` (String variant \| Boolean) \| `null` |
| JSON payload | `flags.getFlagPayload('key')` | `flags.get_flag_payload("key")` | `flags.GetFlagPayload("key")` | `flags.getFlagPayload("key")` → String |
| Multivariate support | ✅ | ✅ | ✅ | ✅ |
| Restrict to specific flags | `{ flagKeys: [...] }` | `flag_keys=[...]` | `FlagKeys: []string{...}` | `.flagKeys(List.of(...))` |
| Snapshot filtering for capture | `flags.onlyAccessed()`, `flags.only([...])` | `flags.only_accessed()`, `flags.only([...])` | `flags.OnlyAccessed()`, `flags.Only([]string{...})` | `flags.onlyAccessed()`, `flags.only(...)` |
| Legacy per-flag calls (deprecated) | `isFeatureEnabled`, `getFeatureFlag`, `getFeatureFlagPayload`, `capture({sendFeatureFlags})` | `feature_enabled`, `get_feature_flag`, `get_feature_flag_payload`, `send_feature_flags=True` | `IsFeatureEnabled`, `GetFeatureFlag`, `GetFeatureFlagPayload`, `Capture.SendFeatureFlags` | `isFeatureEnabled`, `getFeatureFlag`, `getFeatureFlagPayload`, `appendFeatureFlags(true)` |
| "All flags" equivalent | `evaluateFlags()` with no `flagKeys` evaluates every flag | same | same | same |
| Force definition reload | `await client.reloadFeatureFlags()` | `reload_feature_flags()` (listed in local-eval guide SDK tabs) | listed in local-eval guide SDK tabs | listed in local-eval guide SDK tabs |
| Evaluation-context tags | `evaluationContexts` option (5.23.0+; legacy `evaluationEnvironments` 5.10.0+) | **UNVERIFIED** param name | **UNVERIFIED** param name | `evaluationContexts` config field (seen in `PostHogConfig.kt`) |

Return-type semantics are identical across the four SDKs by design: variant string for multivariate, `true` for enabled boolean, `false` for disabled, and language-native "absent" (`undefined`/`None`/`nil`/`null`) when the flag was not returned by evaluation.

Exact full signatures (parameter ordering, generics) beyond what the docs show were not exhaustively verified for Python/Java; treat the shapes above as documented behavior and confirm against pinned-version source when writing the adapter. Mark: **partially UNVERIFIED (exact signature details)**.

---

## 4. Local evaluation

Source: https://posthog.com/docs/feature-flags/local-evaluation

- **Supported in all four target SDKs** (docs: "only available in the Node, Ruby, Go, Python, C#/.NET, PHP, Java, and Rust SDKs").
- Mechanism: SDK polls PostHog's `/flags/definitions` endpoint in the background and evaluates flags in-process using caller-supplied person/group properties. Each definition carries a `version` used for change detection (bumped on flag edits *and* on referenced-cohort edits).
- **Billing**: each definitions poll is billed as 10 flag requests.

| Aspect | Node | Python | Go | Java |
| --- | --- | --- | --- | --- |
| Enable | `secretKey` (preferred, phs_/phx_) or deprecated `personalApiKey` option; `enableLocalEvaluation` (default `true` when key present) | `personal_api_key=` init param; `enable_local_evaluation=True` (default) | `Config.SecretKey` (phx_ or phs_; `PersonalApiKey` is deprecated alias) | `.personalApiKey("phx_...")`; setting it auto-enables `localEvaluation` unless explicitly `false`; also `.localEvaluation(true)` |
| Polling interval default | 30 s per local-eval guide snippet; the Node docs options table says `featureFlagsPollingInterval` default `300000` ms (5 min) — **docs are internally inconsistent; verify at pin time** | `poll_interval=30` (seconds, from `client.py`) | `DefaultFeatureFlagsPollingInterval = 5 * time.Minute` (from `config.go`); overridable, incl. `NextFeatureFlagsPollingTick func()` | `pollIntervalSeconds` default 30 |
| Fallback when local eval impossible | Falls back to `/flags` request unless `onlyEvaluateLocally: true` (then `undefined`) | Same (`only_evaluate_locally`); returns `None` if local-only fails | Same (`OnlyEvaluateLocally`); returns `nil` | Docs state automatic fallback to remote for non-locally-evaluable flags; per-call `onlyEvaluateLocally` toggle **UNVERIFIED** (a `PostHogFeatureFlagOptions.kt` exists in the module; not inspected) |
| Cohorts in local eval | Dynamic cohorts supported (restriction lifted for Node ≥2.6.0) with constraints below | Supported (≥2.4.0) with constraints | Supported (docs: restriction "does not apply to our Go SDK") | Docs list "depend on static cohorts" as a local-eval blocker; dynamic-cohort local evaluation in Java **UNVERIFIED** |
| Distributed cache for definitions | `flagDefinitionCacheProvider` option (Redis etc.) | `flag_definition_cache_provider` init param | **UNVERIFIED** (docs mention distributed-environments guide for Node/Python only) | `flagDefinitionCacheProvider` config field (`PostHogFlagDefinitionCacheProvider.kt`) |

Flags that can **never** be evaluated locally (all SDKs): experience continuity ("persist across authentication"), linked early-access features, static cohorts, `is_not_set` operator, "stop at first matching condition set" (evaluated only via `/flags` for now). Dynamic-cohort local eval fails when: variant override on the cohort condition, non-person properties, >1 cohort in the definition, cohort grouped with another condition, or nested AND-OR beyond top-level-OR/inner-AND.

**Important adapter consequence:** with local evaluation, the caller is responsible for passing every person/group property the flag conditions reference. Fireweave's evaluation-context mapping must pass person properties, groups, and group properties through on every call.

---

## 5. Remote evaluation: the `/flags` endpoint (formerly `/decide`)

Source: https://posthog.com/docs/api/flags

- POST-only public endpoint, authenticated by **project API key** (`phc_`, safe to expose). Hosts: `https://us.i.posthog.com`, `https://eu.i.posthog.com`, or self-hosted domain.
- Current version: **`/flags?v=2`** (optionally `&config=true` for SDK bootstrap config).
- **The v2 response DOES include evaluation reasons and request IDs.** Per-flag objects contain:
  - `key`, `enabled`, `variant` (multivariate),
  - `reason`: `{ code, condition_index, description }` — e.g. `condition_match` / "Condition set 1 matched", `no_condition_match`,
  - `metadata`: `{ id, version, payload }` (payload is a JSON string).
  - Top level: `errorsWhileComputingFlags` (bool — true during partial evaluation failures/incidents, enables partial client-side updates), `requestId` (UUID), and `quotaLimited` (array, present when limited).
- Experiment holdouts surface as variant values `holdout-{id}`.
- Request body supports `distinct_id`, `groups`, `person_properties`, `group_properties`, `evaluation_contexts` (legacy `evaluation_environments`), and GeoIP override via the forwarded-IP header.
- Runtime filtering: server vs client flags are filtered automatically by User-Agent/browser-header heuristics (`posthog-node/` etc. are recognized as server).
- **Latency**: every remote check is a network round trip; PostHog does not publish latency numbers (**UNVERIFIED — no official latency characteristics documented**). All four SDKs default the flag-request timeout to **3 s** (`featureFlagsRequestTimeoutMs` / `feature_flags_request_timeout_seconds` / `FeatureFlagRequestTimeout` / Java **UNVERIFIED** config name).
- **Adapter opportunity**: the Node SDK's `PostHogFlagsResponse` type exposes `flags` (with `reason`/`metadata`), `requestId`, `quotaLimited`, `evaluatedAt` (see https://posthog.com/docs/references/posthog-node-5.39.3/types/PostHogFlagsResponse). Whether each SDK's *snapshot object* exposes per-flag `reason`/`requestId` publicly varies — **UNVERIFIED per SDK**; if the high-level snapshot hides reasons, Fireweave's "evaluation details" metadata may be limited to value+variant+payload unless we use lower-level SDK APIs. Flag this for adapter design.

---

## 6. Identity, person properties, groups

Consistent across all four SDKs:

- **`distinct_id` is required** for flag evaluation and (conceptually) for capture; server-side events must use the same distinct ID the frontend uses so events link up.
- **Person property / group inputs to evaluation**: all four accept `personProperties`, `groups` (map of group type → group key), and `groupProperties` (map of group type → property map) on the evaluate call. These override server-stored properties for that evaluation (and are *required* inputs for local evaluation).
- **Anonymous/personless events**: set event property `$process_person_profile: false`. Python additionally auto-marks events captured with no context/distinct_id as personless with an auto-generated ID. Go and Java generate personless events with auto-UUID when request-context has no distinct ID (but Go's `EvaluateFlagsWithContext` never invents an ID — returns `ErrNoDistinctID`; Java's `evaluateFlags()` returns an **empty snapshot** when no distinct ID is available — a cross-SDK difference worth normalizing in Fireweave).
- **identify/alias**: all four expose `alias`. Node/Python manage identity via contexts (`withContext` / `new_context` + `identify_context`); person properties are set via `$set`/`$set_once` on capture (Java has `.userProperty()`/`.userPropertySetOnce()` builders; Node has helper methods).
- **GeoIP**: disabled by default server-side in all four (`disableGeoip: true` / `disable_geoip=True` / `DisableGeoIP` nil→true / Java always disregards server IP). GeoIP overrides go through `person_properties` (`$geoip_*` keys).
- **Groups**: `groupIdentify` (Node), `group_identify` (Python), `GroupIdentify` message (Go), `group()` (Java) create/update groups; `groups` param on capture associates events. Group analytics is a paid feature.

---

## 7. Event capture, exposure events, batching, flush, shutdown

| Aspect | Node | Python | Go | Java |
| --- | --- | --- | --- | --- |
| Capture call | `client.capture({distinctId, event, properties, groups, flags, timestamp, uuid})`; `captureImmediate` for serverless | `posthog.capture(event, distinct_id=, properties=, ...)` (context-aware) | `client.Enqueue(posthog.Capture{DistinctId, Event, Properties, Groups, Flags})` returns `error` | `posthog.capture(distinctId, event, PostHogCaptureOptions)` |
| Batch trigger | `flushAt` 20 events / `flushInterval` — docs table says 10 000 ms, source comment in `packages/node/src/types.ts` says default 5000 — **discrepancy, verify at pin** | `flush_at=100` / `flush_interval=5.0` s | `BatchSize` 100 / `Interval` 5 s | `flushAt=100` / `maxBatchSize=100` / `flushIntervalSeconds=5` |
| Queue bound | `maxQueueSize` 10 000 | `max_queue_size=10000` | `MaxQueueSize` (default `DefaultMaxQueueSize`); **queue-full drops newest and returns `ErrQueueFull`** (not reported via failure callback) | `maxQueueSize=10000` |
| `$feature_flag_called` exposure events | Sent automatically when `flags.isEnabled()`/`getFlag()` is called (snapshot API); deduped per `(distinct_id, flag, value)` in an LRU (`maxCacheSize` 50 000); `getFlagPayload()` never sends one; per-call `sendFeatureFlagEvents` option on legacy API | Same semantics; dedup cache size **UNVERIFIED** | Same semantics | Same; `sendFeatureFlagEvent` config (default true); dedup cache `featureFlagCalledCacheSize` default **1000** |
| Flush | implicit via shutdown; serverless: `flushAt:1, flushInterval:0` + `await shutdown()` | `posthog.flush()`; `sync_mode=True` for fully synchronous sends | flush on Close/interval; `Callback` for success/failure | `posthog.flush()` explicit |
| Shutdown | `await client.shutdown()` — async; stops flag pollers and flushes remaining events. Explicit timeout parameter **UNVERIFIED** | `posthog.shutdown()` — **blocking**, flushes | `client.Close()`; `ShutdownTimeout` config — default zero = **waits indefinitely** (backward compat); retries: `MaxRetries` default 3 (4 attempts) | `posthog.close()` after optional `flush()` — flushes before exit per docs; timeout **UNVERIFIED** |

**Lifecycle ordering for the adapter**: construct client (starts queue worker + flag poller if secret key present) → serve evaluations/captures → on shutdown: stop accepting new work, then Node `await shutdown()` / Python `shutdown()` / Go `Close()` (set `ShutdownTimeout`!) / Java `flush(); close()`. Go's indefinite default Close wait and Node's async shutdown are the two sharp edges; Fireweave should impose its own shutdown deadline around both.

---

## 8. Error, failure, and quota behavior

- **Flag calls do not throw** in Node/Python/Java: on network failure, timeout, or auth failure they return the "absent" value (`undefined`/`None`/`null`) or an empty snapshot. **Go returns `(flags, err)`** — the only SDK with explicit error returns from evaluation (`ErrNoDistinctID`, transport errors). Node docs: "The SDK does not throw errors for things happening in the background"; errors surface via `client.on('error', cb)` (Node), `on_error` callback (Python), `Logger`/`Callback` (Go), debug logs (Java).
- **Invalid project API key**: not explicitly documented per-SDK; capture ingestion failures surface via the error hooks above. **UNVERIFIED: specific SDK behavior distinguishing 401/403 from other failures.** Invalid/insufficient secret key for local evaluation causes the definitions poll to fail (logged); flags then fall back to remote evaluation. **UNVERIFIED: exact per-SDK logging/retry on definitions-poll auth failure.**
- **Quota limiting (429-class / billing)**: when the org exceeds its feature-flag quota, `/flags` returns `{"flags": {}, "quotaLimited": ["feature_flags"], ...}` (HTTP 200-shaped, not an error). Documented SDK behavior (https://posthog.com/docs/feature-flags/cutting-costs): SDKs return defaults — `false` for `isFeatureEnabled`, `null`/`None` for `getFeatureFlag` — surface the quota-limited state in the response object, and log a warning in debug mode. The `/local_evaluation`-definitions endpoint is also quota-limited (PostHog/posthog PR #28564). **Fireweave must treat "empty flags + quotaLimited" as "flag not found → serve Fireweave default," not as an outage.**
- **Malformed responses**: **UNVERIFIED** — not documented; assume absent-value behavior like other failures and verify in adapter tests.
- **Stale cache on polling failure (local eval)**: the SDKs keep serving the last successfully fetched definitions between polls; behavior on *persistent* poll failure (TTL? indefinite staleness?) is **UNVERIFIED** in docs. Python has extra machinery: `flag_fallback_cache_url` and `flag_definition_cache_provider`; Node/Java have `flagDefinitionCacheProvider`. Adapter should expose "definitions age" if the SDK surfaces it (**UNVERIFIED** whether any SDK exposes last-poll timestamp publicly).
- **Flag-request retries**: Go `FeatureFlagRequestMaxRetries` default 1; Python `feature_flags_request_max_retries=1`; Node core `fetchRetryCount`/`fetchRetryDelay`; Java **UNVERIFIED**.

---

## 9. Cold start

Documented in the local-evaluation guide:

- On startup the SDK needs **up to one polling interval** to fetch definitions; during that window local evaluation returns `undefined`/`None` (falls back to remote unless `onlyEvaluateLocally`). Docs recommend per-flag defaults and, for short-lived workers, a **shared flag-definition cache** so definitions survive restarts and eliminate the cold-start window.
- Node docs say definitions load "on initialization and at the poll interval" — an immediate initial fetch, but still async; first evaluations may race it.
- Java has `preloadFeatureFlags` (default `true`).
- Python `Client` has `eager_start` behavior for its consumer pool (queue lane starts on init).
- Whether Go fetches definitions immediately at construction vs. at first tick: **UNVERIFIED**.

Fireweave implication: the adapter's "readiness" concept should be *evaluated-at-least-one-definitions-poll* when in local-eval mode; before that, evaluations are remote-fallback (slower) or absent (local-only). Consider exposing a `waitForInitialization`-style hook built on `reloadFeatureFlags()`.

---

## 10. Thread-safety and concurrency

- **Node**: single event loop; the client is a singleton with an internal async queue. Context state (`withContext`, ≥5.17.0) uses request-scoped propagation (AsyncLocalStorage-style — **implementation detail UNVERIFIED**). Safe for concurrent requests on one instance.
- **Python**: background consumer threads (`thread=1` default, configurable `thread_count`) drain a `queue.Queue` (thread-safe); pool start is lock-guarded and idempotent (verified in `client.py`). Contexts use `contextvars`-style scoping (**UNVERIFIED implementation**), documented safe across function calls. `sync_mode=True` makes capture synchronous.
- **Go**: client designed for concurrent use — buffered channel/worker model inherited from `analytics-go`; `Enqueue` is non-blocking (drops + `ErrQueueFull` when full). Request context flows through `context.Context`.
- **Java**: internal queue + background executor for batching. **Request context is `ThreadLocal`** — explicitly documented: "If your framework moves work across threads, propagate the context explicitly." Remote flag results are cached in-memory per (distinct_id, flag) — `featureFlagCacheSize` 1000, TTL `featureFlagCacheMaxAgeMs` 5 min — this cache is unique to Java and means repeat evaluations within 5 minutes can return **cached (possibly stale) results**. Fireweave must document or tune this.

---

## 11. Initialization modes the adapter must support

1. **Remote-only** — project API key (`phc_`) only. Every evaluation is a `/flags?v=2` round trip (3 s default timeout). No secret key needed. Works in all four SDKs.
2. **Local evaluation** — project API key + secret key (`phs_` Feature Flags Secure API Key preferred; `phx_` personal key still accepted but PostHog says it "will be deprecated for local evaluation in the future"). Background definitions poller (30 s default; Go 5 min). Caller must supply all condition properties. Non-locally-evaluable flags fall back to remote automatically.
3. **Local-only** — same as (2) plus `onlyEvaluateLocally` per call: never hits `/flags` at evaluation time; unevaluable flags → absent value. (Java per-call toggle **UNVERIFIED**, see §4.)
4. Node/Python only today: distributed definition cache via `flagDefinitionCacheProvider` for multi-worker/edge deployments (Java has the config field too; Go **UNVERIFIED**).

Key-mode matrix for the adapter: `phc_` required always (capture + remote flags); `phs_`/`phx_` required only for modes 2–3 and for remote-config payload decryption (Node `getRemoteConfigPayload`).

---

## 12. Testing seams per SDK

| SDK | Injection points (verified in source/docs) |
| --- | --- |
| Node | `fetch?: (url, options) => Promise<PostHogFetchResponse>` constructor option — full HTTP transport injection. Plus `overrideFeatureFlags(...)` (bool/list/map/payloads — in-process flag stubbing), `flagDefinitionCacheProvider`, `before_send` (mutate/drop events), `disabled`-style: **UNVERIFIED whether a `disabled` option exists in Node**. |
| Python | `sync_mode=True` (deterministic sends), `disabled=True` (no network at all — documented "Disabling requests during tests"), `send=False`, `on_error` callback, `before_send`, `flag_definition_cache_provider`, `flag_fallback_cache_url`. No documented HTTP-client injection — transport is internal (`requests`-based); mock at socket/httpretty level or point `host` at a stub server. |
| Go | `Config.Transport http.RoundTripper` — first-class transport injection. Plus `Logger`, `Callback` (success/failure notification), `BeforeSend`, `NextFeatureFlagsPollingTick` (control poll timing in tests), `Endpoint` override, injectable-looking `now func()` (unexported). |
| Java | No public HTTP-client injection found in `PostHogConfig.kt` (OkHttp is internal; `proxy: Proxy?` is configurable). Seams: `host` override → point at a stub server (WireMock/MockWebServer), `flagDefinitionCacheProvider`, `addBeforeSend` hooks, `onFeatureFlags` callback, `addIntegration(PostHogIntegration)`. Weakest testing story of the four. |

For Fireweave's own unit tests, prefer testing against the Fireweave provider interface with a fake adapter; use the seams above only for adapter integration tests (plus a real stub HTTP server for Python/Java).

---

## 13. Security risks and key handling

- **`phc_` project key**: public by design; still avoid hardcoding (env vars).
- **`phx_` personal API key**: user-scoped, broad-permission secret. **`phs_` Feature Flags Secure API Key**: project-scoped secret, only grants flag-definition access — strictly better; recommend Fireweave require/prefer `phs_` for local-eval mode. Both must never reach client-side code or logs. Node `secretKey` / Go `SecretKey` accept either; Python/Java take them via `personal_api_key`/`personalApiKey` params (naming lag).
- **Providing a secret key triggers periodic definition polling even if flags are unused** (Node docs) — cost and traffic implication; Fireweave should only pass the secret key when local eval is requested (Node also has `enableLocalEvaluation: false` for key-without-polling use).
- **Logging**: debug modes (`client.debug()`, `debug=True`, `Verbose`, `.debug(true)`) log verbose SDK internals — whether keys are ever logged is **UNVERIFIED**; Fireweave should never enable SDK debug in production by default and must redact keys in its own logs. Python has `privacy_mode` and `before_send` for scrubbing event PII; Node/Go have `before_send`/`BeforeSend`; Java `addBeforeSend`.
- **Tracing headers** (`X-PostHog-Distinct-Id`/`-Session-Id`) are client-controlled analytics context, **not** authentication — documented in Node/Go/Java docs. Fireweave must not use them for security-sensitive targeting; pass authenticated distinct IDs explicitly.
- Flag definitions fetched for local evaluation contain your targeting rules (may embed emails/property values) in server memory — normal, but relevant to memory-dump threat models.

---

## 14. Dependency footprint and licensing

| SDK | License | Runtime dependencies |
| --- | --- | --- |
| `posthog-node` 5.46.1 | MIT | `@posthog/core ^1.45.1` (PostHog's own, MIT); **peer dep `rxjs ^7.0.0`** (Apache-2.0) — notable: consumers must have rxjs installed. Node ≥ 20.20. |
| `posthog` 7.31.0 (PyPI) | MIT | Historically: `requests`, `six`, `python-dateutil`, `backoff`, `distro` — exact 7.x dependency list **UNVERIFIED** (check `pyproject.toml` at pin time). Optional extras for LLM providers. |
| `posthog-go` v1.22.0 | MIT | Go modules; exact go.mod list **UNVERIFIED** (based on `analytics-go` lineage; includes compression libs for zstd/brotli capture modes — verify). |
| `posthog-server` 2.9.0 | MIT | `com.posthog:posthog` 6.27.0 (shared Kotlin core, MIT), `kotlin-stdlib-jdk8` 2.1.10 (Apache-2.0), `gson` 2.10.1 (Apache-2.0), `okhttp` 4.12.0 (Apache-2.0). Kotlin runtime lands on the consumer's classpath — worth noting for pure-Java shops. |

All four SDKs are MIT; transitive licenses observed are MIT/Apache-2.0 — no copyleft concerns. OpenFeature providers: MIT (Node, Python), Apache-2.0 (community Go).

---

## 15. Known cross-SDK semantic differences (normalize in Fireweave)

1. **Error surface**: Go returns `(flags, err)`; Node/Python/Java swallow errors and return absent values. Fireweave should define one error taxonomy and map both styles into it.
2. **Polling default**: Go polls definitions every **5 min**; Node/Python/Java default **30 s** (Node docs table inconsistently says 5 min — verify). Staleness windows differ 10× out of the box.
3. **Java's remote flag result cache** (per distinct_id+flag, 5 min TTL, 1000 entries) has no equivalent in the other SDKs → Java can return values up to 5 minutes stale even in remote mode.
4. **Missing distinct ID**: Java `evaluateFlags()` returns an empty snapshot; Go returns `ErrNoDistinctID`; Node/Python contexts supply one or evaluation is caller-errored. Different failure shapes for the same mistake.
5. **`$feature_flag_called` dedup cache sizes**: Node 50 000 vs Java 1000 (Python/Go **UNVERIFIED**) → exposure-event volume differs under high cardinality.
6. **Queue overflow**: Go drops the newest message and returns `ErrQueueFull` (silent to callbacks); other SDKs' overflow behavior is **UNVERIFIED** in docs.
7. **Dynamic cohort local evaluation**: fully supported in Go and newer Node/Python; Java support **UNVERIFIED** (docs only mention static-cohort restriction).
8. **Shutdown**: Go `Close()` waits **indefinitely** by default; Python `shutdown()` blocks; Node `shutdown()` is async; Java is `flush()` + `close()`. Fireweave must wrap all four with its own timeout.
9. **Sync capture mode** exists only in Python (`sync_mode`) and Node (`captureImmediate`).
10. **Transport injection** exists in Node (`fetch`) and Go (`Transport`) but not Python/Java.
11. **Java requires JVM-thread-affine request context** (ThreadLocal); Node/Python have async-safe context propagation.
12. **Personless-event auto-generation** differs: Python auto-generates personless events for ID-less captures; Go/Java only do so under request-context middleware; Node requires distinctId or context.

---

## 16. Open items for the adapter design (all marked UNVERIFIED above)

- First SDK version supporting `evaluateFlags()` per language (needed only if supporting version ranges rather than exact pins).
- Whether each SDK's snapshot object exposes `/flags` v2 `reason`/`requestId`/flag `version` metadata publicly (Node's low-level `PostHogFlagsResponse` does; snapshot-level access per SDK unconfirmed). This determines how rich Fireweave's `EvaluationDetails` can be per backend.
- Java: per-call `onlyEvaluateLocally`, flag-request timeout config name, retry policy, shutdown timeout.
- Go: distributed definitions cache support; immediate-vs-delayed initial definitions fetch.
- Behavior on malformed `/flags` responses and on persistent definitions-poll failure (staleness policy) — recommend adapter-level integration tests against a stub server for both.
- Exact current transitive dependency lists for posthog-python 7.31.0 and posthog-go v1.22.0.
