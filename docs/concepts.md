# Concepts: decisions, reasons, errors, capabilities

## The decision model

Every evaluation — whether it enters through an OpenFeature getter or the Fireweave-native detailed API — produces a canonical **Decision** (`spec/decision.schema.json`):

| Field | Meaning |
| --- | --- |
| `flagKey` | The flag that was evaluated |
| `value` | The resolved value — or your **default** on any failure |
| `variant` | Variant name for multivariate flags (absent otherwise) |
| `reason` | Why this value was chosen (below) |
| `errorCode` / `errorMessage` | OpenFeature error code + safe message; only on error decisions |
| `metadata` | Scalar-only `fireweave.*` enrichment (flag version, quota, cache provenance, error kind — see [openfeature.md](openfeature.md#detailed-resolution)) |

The OpenFeature path surfaces a Decision as `ResolutionDetails` / `FlagEvaluationDetails`; the Fireweave-native path returns it directly (Python `client.flags.get_details(...)`, Java `client.evaluate(...)`, Node/Go `runtime.evaluate(...)` — see [compatibility.md](compatibility.md#known-gaps) for the naming divergence).

**Defaults never throw.** The client evaluation API returns your default with an error decision for every abnormal condition — not-ready, unknown flag, type mismatch, invalid context, network failure, quota limiting, post-shutdown calls. If you got an exception out of a flag getter, that's a bug; report it.

## Reasons

OpenFeature-standard reason strings, as produced by this SDK:

| Reason | Produced when |
| --- | --- |
| `TARGETING_MATCH` | Flag resolved and targeting/conditions matched |
| `SPLIT` | Value assigned by percentage-rollout bucketing (surfaced when the backend reports it) |
| `DISABLED` | Flag exists but is turned off — you get the flag's off-value/default |
| `STALE` | Served from last-good/cached definitions while the backend is degraded |
| `ERROR` | Any error decision (default value; inspect `errorCode` and `fireweave.errorKind`) |

## Error taxonomy

Fireweave classifies every failure into one of **15 canonical kinds** (`spec/errors.schema.json`, `contracts/errors.md`), which map onto OpenFeature error codes at the provider boundary. The Fireweave kind is preserved in `flagMetadata["fireweave.errorKind"]`.

| Fireweave kind | OpenFeature `errorCode` | Retryable | When |
| --- | --- | --- | --- |
| `NotReady` | `PROVIDER_NOT_READY` | yes | Evaluation before successful init |
| `FlagNotFound` | `FLAG_NOT_FOUND` | no | Flag absent from snapshot/definitions; includes quota-limited empty snapshots (`fireweave.quotaLimited: true`) |
| `TypeMismatch` | `TYPE_MISMATCH` | no | Stored type ≠ requested typed getter |
| `InvalidContext` | `INVALID_CONTEXT`, or `TARGETING_KEY_MISSING` when the targeting key is required and absent | no | Bad/oversized context, reserved-key misuse |
| `Authentication` | `GENERAL` | no | 401 / invalid project or secret key |
| `Authorization` | `GENERAL` | no | 403 / key lacks permission |
| `RateLimited` | `GENERAL` | yes | HTTP 429 |
| `Timeout` | `GENERAL` | yes | Flag-request or init deadline exceeded |
| `Network` | `GENERAL` | yes | DNS / connect / reset / TLS failure |
| `BackendUnavailable` | `GENERAL` | yes | 5xx / upstream down |
| `MalformedResponse` | `PARSE_ERROR` | no | Non-JSON or schema-invalid backend body |
| `UnsupportedCapability` | `GENERAL` | no | Extension/capability not in this build (e.g. guardrails, Java `PostHogAdapter.create`) |
| `Configuration` | `PROVIDER_FATAL` (init) / `GENERAL` (runtime) | no | Invalid host, missing required key, bad option combination |
| `AlreadyClosed` | `PROVIDER_NOT_READY` | no | Call after shutdown (kind preserved in `fireweave.errorKind`) |
| `Internal` | `GENERAL` | no | Unexpected invariant violation |

Language surfaces are idiomatic: Node `FireweaveError` (with `kind`, `openFeatureErrorCode`), Python per-kind exception classes (`NotReadyError`, `TimeoutError_`, …) sharing `ErrorKind`, Go `*fireweave.Error` values with `Kind`, Java enum-kinded `FireweaveException`/`FireweaveError`. In all languages, error **messages are secret-redacted** (`phc_`/`phs_`/`phx_` keys, bearer tokens → `[REDACTED]`) and safe to log.

`PROVIDER_NOT_READY` therefore means one of two very different things — check `fireweave.errorKind`: `NotReady` (wait/retry) vs `AlreadyClosed` (you're evaluating after shutdown; fix your lifecycle).

## Capability matrix

`capabilities.get` **[Fireweave extension]** reports what a build + attached adapter can do (`spec/capabilities.schema.json`), as **static** (compile-time: `controlPoints`, `flags`, `releases`, `exposures`, `signals`, `guardrails: false`, `inMemoryAdapter`, `remoteAdapter`, …) and **runtime** (adapter-backed: `remoteEvaluation`, `localEvaluation`, `localOnly`, `exposureEmission`, `sideEffectFreeReads`, `groupAnalytics`, plus limits like `intSafeMaxAbs`) feature maps.

Use it for defensive gating instead of version sniffing:

```js
const caps = fireweave.capabilities.get();
if (caps.runtime.features.localEvaluation) { /* low-latency path */ }
```

The canonical operation-name list (identical in all four languages) is in [extensions.md](extensions.md). Phase-one truths: `guardrails` is always `false`; Node reports `controlPoints: true` alongside the retained `flags: true` ([ADR-0007](adr/0007-control-point-vocabulary.md)) and no longer reports `posthogAdapter` at all ([ADR-0006](adr/0006-node-drops-direct-posthog-adapter.md)); Java reports `posthogAdapter: false` until the upstream artifact ships ([posthog.md](posthog.md#java)).

## Feature-labeling convention used across these docs

- **[OpenFeature standard]** — spec-defined behavior; portable to any OpenFeature provider.
- **[Fireweave extension]** — Fireweave-owned API (`FireweaveClient`, `fireweave.*` metadata, capability matrix, context bounds).
- **[vendor-specific]** — behavior of a direct vendor adapter (key types, quota, caches). Python and Go only; removed on Node in v3.
- **[Experimental]** — shipped but subject to change without a major version (guardrails stub, transaction-context usage).
- **[Planned — not implemented]** — documented intent, no code yet (OpenFeature tracking §6, browser/mobile SDKs, real guardrail evaluation).
