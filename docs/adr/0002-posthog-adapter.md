# ADR-0002: PostHog Adapter

- **Status:** Accepted
- **Date:** 2026-07-27
- **Deciders:** Agent D (Architecture & API lead)
- **Tags:** posthog, adapter, evaluation, lifecycle

## Context and Problem Statement

Phase-one flag evaluation must use PostHog without reimplementing local evaluation, caching, batching, retries, or exposure dedup. Official PostHog OpenFeature providers are pre-1.0 (Node/Python) or absent (Go/Java). PostHog SDKs are mid-migration to `evaluateFlags()` snapshots and differ in error surfacing, polling defaults, shutdown, and caching. The adapter must wrap official SDKs uniformly and normalize mismatches.

## Decision Drivers

- No custom flag evaluator
- Uniform cross-language Fireweave semantics
- Snapshot API (`evaluateFlags`) as the only evaluation entry
- Secret keys never required for remote-only mode; never shipped to browsers
- Test seams without mandating network in unit tests
- Public API free of PostHog types

## Considered Options

1. **Wrap official PostHog SDK in all four languages** *(selected)*
2. Use official OF providers where present + raw SDK elsewhere — rejected (dual stacks)
3. Direct HTTP to `/flags` + self-built local eval — rejected (reimplementation)
4. Wait for PostHog OF providers 1.0 — rejected for phase-one timeline

## Decision Outcome

**Wrap the official PostHog SDK in each language** behind `PostHogAdapter implements BackendAdapter`. Target pinned versions from the decision brief:

| Language | PostHog SDK pin |
|---|---|
| Node | `posthog-node` **5.46.1** |
| Python | `posthog` **7.31.0** |
| Go | `posthog-go` **v1.22.0** |
| Java | **none published** — see superseded-pins errata below |

Revisit official OF providers only after 1.0 + four-language coverage.

### Superseded pins (errata, 2026-07-27)

| Original pin in this ADR | Status | Current truth |
|---|---|---|
| Java `com.posthog:posthog-server` **2.9.0** | **Superseded** (orchestrator ruling 10; adversarial RB-3) | Artifact is **not on Maven Central**. Java adapter is a `PostHogClientApi` seam only; `PostHogAdapter.create(config)` → `UnsupportedCapability`. Do not treat 2.9.0 as a live dependency pin. |
| Context mapping row `fireweave.evaluationContexts` | **Rejected** (ruling 13) | Do not implement; strip any residual builder/API that reintroduces evaluation-context tags (adversarial H-7 on Java). |

## Adapter Responsibilities

### Init modes

| Mode | Keys | Behavior |
|---|---|---|
| **Remote** | `phc_` project API key only | Every evaluation uses `/flags?v=2` via SDK; no definitions poller |
| **Local** | `phc_` + secret `phs_` (preferred) or `phx_` | Background definitions poll; in-process eval; remote fallback for non-local flags |
| **Local-only** | same as Local + `onlyEvaluateLocally` | No `/flags` at eval time; unevaluable → absent → Fireweave default |

Rules:

- Prefer **Feature Flags Secure API Key** (`phs_`) over personal (`phx_`) for local eval.
- Pass secret key **only** when local (or local-only) mode is requested — secret presence can start polling even if unused.
- Host defaults: `https://us.i.posthog.com` (overridable; EU/self-hosted supported).
- Optional: inject existing PostHog client (advanced); ownership per ADR-0001 §5.

### Lifecycle

```
UNINITIALIZED → INITIALIZING → READY
                    ↓              ↓
                  FATAL         STALE / ERROR (recoverable)
                    ↓              ↓
                 SHUTDOWN ←———————┘
```

1. Construct SDK client (queue worker; poller if secret present).
2. Local mode: await first definitions load (`reloadFeatureFlags` / equivalent) or fail FATAL on hard auth/config errors; soft poll failures → STALE while serving last-good definitions when available.
3. Remote-only: READY after successful client construction.
4. Shutdown: stop accepting work → flush → close with Fireweave deadline (default 10s). Normalize: Node `await shutdown()`, Python `shutdown()`, Go `Close()` with `ShutdownTimeout`, Java `flush()` + `close()`.

### Evaluation: `evaluateFlags()` snapshot only

- Adapter maps Fireweave evaluation request → PostHog `evaluateFlags` / `evaluate_flags` / `EvaluateFlags`.
- Read boolean/variant/payload from the **snapshot** (`isEnabled` / `getFlag` / `getFlagPayload` equivalents).
- Do **not** call deprecated per-flag APIs (`getFeatureFlag`, `isFeatureEnabled`, etc.).
- Optional `flagKeys` restriction when the caller evaluates a single key (perf); otherwise full snapshot is allowed.
- Map `/flags?v=2` reason / `requestId` / `quotaLimited` into Fireweave `Decision` metadata when the SDK snapshot exposes them; if hidden, value+variant+payload remain mandatory and reason may be `UNKNOWN`.

### Context mapping

| Fireweave / OF | PostHog |
|---|---|
| `targetingKey` | `distinct_id` (required) |
| non-reserved context attrs | `person_properties` |
| `fireweave.groups` | `groups` |
| `fireweave.groupProperties` | `group_properties` |
| ~~`fireweave.evaluationContexts`~~ | **Rejected** (ruling 13) — do not map |

Never invent `distinct_id`. Missing key → Fireweave `InvalidContext` (OF `TARGETING_KEY_MISSING`).

### Exposure policy

- **Phase-one default (ruling 20):** side-effect-free evaluate/OF reads in all four languages; Fireweave-owned exposure only when opted in (`sendExposure` / language equivalent). Vendor `$feature_flag_called` is suppressed on Node local snapshot path (RB-2).
- Opt in via evaluate options / Go `SendExposureEvents` / per-call arm, or use Fireweave `exposures.*`.
- Payload-only reads must not emit (PostHog guarantee).
- Fireweave must not emit a second exposure event for the same OF evaluation.

### Error & quota normalization

- Go `(flags, err)` and Node/Python/Java absent-value styles map to one Fireweave taxonomy (ADR-0001 §12).
- `quotaLimited` present with empty flags → `FlagNotFound` → OF `FLAG_NOT_FOUND` + default with metadata `fireweave.quotaLimited: true` (not `Network`/`BackendUnavailable`).
- Missing distinct id: normalize Java empty snapshot and Go `ErrNoDistinctID` to `InvalidContext` (OF `TARGETING_KEY_MISSING`).

## Cross-SDK mismatch normalization (decision brief §5 / Agent C §15)

| Mismatch | Fireweave normalization |
|---|---|
| Error surface (Go err vs absent) | Single taxonomy at adapter boundary |
| Polling default (Go 5m vs 30s) | Adapter sets polling interval default **30s** where the SDK allows override |
| Java remote result cache (5m) | Document; set cache max-age as low as SDK allows for parity; expose capability `staleRemoteCache: true` on Java |
| Missing distinct_id shapes | Always `InvalidContext` (OF `TARGETING_KEY_MISSING`) |
| Exposure dedup cache sizes | Document skew; no Fireweave attempt to equalize PostHog LRU sizes in phase one |
| Queue overflow (Go drops) | Map capture failures to extension errors; flag eval unaffected |
| Shutdown blocking semantics | Unified deadline wrapper |
| Transport injection gaps | Unit tests use `InMemoryAdapter`; PostHog integration tests use fetch/Transport or stub server |
| Java ThreadLocal context | OF/Fireweave path always passes explicit distinct_id + properties |
| Numeric / payload typing | Canonical JSON; ints safe cross-language within 2^53−1; Java overrides `getLongEvaluation` at provider layer |

### OpenFeature-side mismatches handled at provider (not adapter)

Flattened Go context, Node async+Logger, hook stage names, int/float splits — owned by `FireweaveProvider` per language (ADR-0003). Adapter speaks Fireweave canonical request/decision types only.

## Testing seams

- Prefer `InMemoryAdapter` for provider/client unit + OF Gherkin suite.
- PostHogAdapter integration: Node `fetch` inject; Go `Transport`; Python/Java host → WireMock/httpretty stub of `/flags` and `/flags/definitions`.
- Never require production PostHog project for CI unit tests.

## Consequences

- Positive: uniform wrap pattern; snapshot-ready; lifecycle control; PostHog types quarantined.
- Negative: must maintain four SDK pins and normalization table as PostHog migrates.
- Follow-up: confirm snapshot exposure of v2 `reason`/`requestId` per SDK at implementation time (marked UNVERIFIED in research).

## References

- `docs/research/posthog-sdk-matrix.md`
- `docs/orchestration/decision-brief.md` §4–§5
- ADR-0001, ADR-0003
