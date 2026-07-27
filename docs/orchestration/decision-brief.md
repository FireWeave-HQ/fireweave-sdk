# Phase 1 Decision Brief — Fireweave Polyglot SDK

Orchestrator synthesis of Agents A/B/C research (2026-07-27).
Sources: `docs/research/repository-assessment.md`, `docs/research/openfeature-compatibility.md`, `docs/research/posthog-sdk-matrix.md`.

## 1. Recommended repository location

**Standalone polyglot monorepo: `FireWeave-HQ/fireweave-sdk`** (this repo), one directory per language under `sdks/`, shared `spec/`, `contracts/`, `test-server/`. Rationale (Agent A):

- The main FireWeave monorepo is private, Bun/TS-only, proprietary-licensed, and runs on self-hosted EKS runners — unsuitable for a public OSS project.
- A public Go module path (`github.com/FireWeave-HQ/fireweave-sdk/sdks/go`) requires a public repo.
- One repo keeps all four SDKs against a single canonical fixture set (drift prevention is the point of the conformance layer).
- Split into per-language repos only if per-language communities emerge later.

**Supersession note:** internal ADR-017 (2026-07-09, Proposed) already plans per-language thin providers *inside the main repo*. This effort implements ADR-017's core decision (thin OpenFeature provider per language wrapping the official vendor SDK) but relocates it to the public monorepo. An explicit "this repo supersedes ADR-017's in-repo language packs" note must go into ADR-0001. `@fireweaveai/deploy-sdk` (proprietary, TS-only) is prior art and a compatibility target — its wire contracts (beacon payload, env vars `FW_ATTEST_URL`/`FW_PROJECT_API_KEY`, manifest harness block, typed ULIDs) are re-specified from documentation, never copied.

## 2. Supported language versions

| Language | Minimum | Driver |
|---|---|---|
| Node.js | ≥ 20 | posthog-node 5.x requires Node ≥ 20.20; OpenFeature needs ≥ 18 |
| Python | ≥ 3.10 | both openfeature-sdk and posthog 7.x require ≥ 3.10 |
| Go | 1.25 toolchain (module compat per go-sdk) | open-feature/go-sdk v1.17.2 targets Go 1.25 |
| Java | ≥ 11 (OpenFeature floor); verify posthog-server 2.x floor (Kotlin/OkHttp) | dev.openfeature:sdk 1.21.0 = Java 11+ |

## 3. Version pins (verified 2026-07-27)

| | OpenFeature SDK | PostHog SDK |
|---|---|---|
| Node | `@openfeature/server-sdk` **1.22.0** (peer `@openfeature/core` ^1.11) | `posthog-node` **5.46.1** (note rxjs peer dep) |
| Python | `openfeature-sdk` **0.10.0**, pin `<0.11` (pre-1.0) | `posthog` **7.31.0** |
| Go | `github.com/open-feature/go-sdk` **v1.17.2** | `posthog-go` **v1.22.0** |
| Java | `dev.openfeature:sdk` **1.15.1** (CORRECTED — ruling 10; 1.21.0 does not exist) | **none published** (CORRECTED — ruling 10: `com.posthog:posthog-server` unpublished; adapter ships behind a client seam) |

Spec compliance floor: OpenFeature spec **v0.8.0**. All PostHog SDKs MIT. Exact pins recommended because PostHog is mid-migration from per-flag calls to the `evaluateFlags()` snapshot API.

## 4. Official PostHog OpenFeature provider availability → decision

| Language | Official provider | Decision |
|---|---|---|
| Node | `@posthog/openfeature-node-provider` 0.1.0 (weeks old) | **Wrap posthog-node directly** |
| Python | `openfeature-provider-posthog` 0.1.20 (pre-1.0) | **Wrap posthog directly** |
| Go | none official; stale 2024 community provider | **Wrap posthog-go directly** |
| Java | none | **Wrap posthog-server directly** |

Uniform decision (Agent C, consistent with ADR-017): wrapping the official PostHog SDK directly is the least complex option that gives uniform cross-language behavior, lifecycle control, testability, and room for Fireweave metadata. Direct HTTP is ruled out by the no-reimplementation constraint. Revisit official providers when they reach 1.0.

## 5. Important semantic mismatches to normalize (input to Agents D & E)

**OpenFeature side (Agent B):**
- Go providers receive a *flattened* context map; opt-in interfaces (`StateHandler`, `EventHandler`, `Tracker`); value-struct errors.
- Node resolvers are async-only and receive a Node-only `Logger`.
- Numeric typing skew: Node single `number`; int/float splits elsewhere; Java's new `getLongEvaluation` clamps via double to 2^53−1.
- Lifecycle/event/hook shape divergence: `onClose` vs `shutdown`; emitter vs callback vs channel; `finally` vs `finally_after` vs `finallyAfter`; Go lacks hook data.
- Spec `main` has unshipped drafts (provider-emitted init events, domain-scoped providers) — track, don't build on.

**PostHog side (Agent C):**
- Error surfacing: Go returns `(flags, err)`; Node/Python/Java swallow errors and return absent values.
- Local-eval polling defaults: Go 5 min vs 30 s elsewhere.
- Java uniquely caches remote flag results per user for 5 min (stale-value risk) and uses ThreadLocal request context.
- Shutdown: Go `Close()` waits indefinitely by default; Python blocks; Node async.
- Transport injection for tests exists only in Node (`fetch`) and Go (`Transport`); Python/Java need protocol-stub servers.
- All SDKs deprecated per-flag calls in favor of `evaluateFlags()` snapshot API — adapters target the snapshot API.
- `/flags?v=2` returns evaluation reasons, `requestId`, `quotaLimited` — usable for Fireweave detailed decisions.

**Identity/keys:**
- OpenFeature `targetingKey` → PostHog `distinct_id` (confirmed by ADR-017 and rollout-server `verify_cohort_keying`; cohort key e.g. `orgId` must be stable for sticky ramps).
- Local evaluation requires a secret key: prefer PostHog's project-scoped Feature Flags Secure API Key (`phs_`) over personal API key (`phx_`); both are server-side-only secrets.

## 6. Conformance strategy

Run the OpenFeature spec's Appendix B Gherkin `evaluation.feature` suite per language (cucumber runners) against Fireweave providers backed by the in-memory adapter — officially supported without flagd. Additionally diff evaluation details against each language's official in-memory provider as a behavioral oracle. Fireweave's own cross-language fixture harness (Agent E) covers everything beyond standard evaluation.

## 7. Major risks

1. **License decision unmade (release blocker, company decision).** Working assumption for scaffolding: **MIT** (matches PostHog SDKs; OpenFeature uses Apache-2.0 — either acceptable). Must be ratified before any publication; publication is already gated on explicit authorization. No code copied from proprietary `deploy-sdk`.
2. **ADR-017 overlap** — must be explicitly superseded/aligned to avoid two divergent SDK efforts under the same npm scope.
3. **Java greenfield** — no `java` surface in the main repo's `SURFACE_REGISTRY`/manifest schemas, no Maven groupId (`ai.fireweave` needs Central verification). Upstream schema additions filed as follow-ups; not phase-one blockers for building the SDK itself.
4. **Registry namespaces unverified** — PyPI `fireweave`/`fireweave-sdk`, Maven `ai.fireweave`; npm trusted-publisher entries needed per package. Check availability before finalizing names; do not publish.
5. **PostHog flag-API migration in flight** — exact pins + adapter isolation of the snapshot API; watch for breaking changes.
6. **Private `@fireweaveai/contracts`** — rollout/beacon wire shapes must be re-specified here and kept in parity by convention (parity comments pointing at canonical internal files).
7. **Pre-1.0 OpenFeature Python SDK** — pin `<0.11`, isolate anything experimental.
8. **AGPL adjacency** — never reuse code from `fireweave-data-engine` (AGPL-3.0).
9. **Governance from scratch** — no CLA/DCO precedent in org; adopt **DCO** (contributor-friendly default; no CLA without explicit company decision).

## 8. Phase 2 authorization

Agents D (architecture/ADRs/`spec/`) and E (contracts/fixtures/`test-server/`) are authorized to start in parallel. Implementation (F–I) remains blocked until the orchestrator verifies the Phase 2 exit checklist in the ledger.
