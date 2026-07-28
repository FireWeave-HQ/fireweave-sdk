# ADR-0003: OpenFeature Boundary

- **Status:** Accepted
- **Date:** 2026-07-27
- **Deciders:** Agent D (Architecture & API lead)
- **Tags:** openfeature, provider, hooks, context

## Context and Problem Statement

Fireweave must be a well-behaved OpenFeature provider while also offering Fireweave-specific APIs. Mixing those concerns (smuggling extensions through hooks, forking OF types, or depending on experimental OF features) would break ecosystem compatibility and conformance. Spec `main` has unshipped drafts; Python OF SDK is pre-1.0.

## Decision Drivers

- Spec compliance floor: **OpenFeature v0.8.0**
- Stable/hardening features only in core path
- Clear split: OF = flags; FireweaveClient = extensions
- Hooks must not become a backchannel for proprietary APIs
- Cross-language provider contract parity

## Decision Outcome

### OpenFeature vs Fireweave extensions

| Concern | Surface |
|---|---|
| Bool/string/number/object flag evaluation | `FireweaveProvider` via OF Client |
| Hooks, domains, events, status | OpenFeature SDK |
| Releases (incl. deploy-attestation beacon via `setContext`/`start`), signals, guardrails, capabilities, detailed decisions, group identify | `FireweaveClient` |
| Exposure policy / side-effect control | Runtime options + optional FireweaveClient detailed eval; OF path documents default side effects |
| Tracking (spec §6 experimental) | Provider `track` implemented no-op-safe, marked `@experimental`; not required for core flags |

Users may use **only** OF (provider registered) or **only** FireweaveClient, or both against the same runtime.

### Identity mapping

- OF `targetingKey` → PostHog `distinct_id` (via adapter).
- Cohort key for sticky ramps **must** be the targeting key (e.g. `orgId`).
- Never auto-generate anonymous IDs during evaluation (ADR-0001 §8).

### Context merge order

Fireweave does **not** re-merge context. The OpenFeature SDK merges per spec §3.2.3:

**API (global) → transaction → client → invocation → before-hook output** (later wins).

Provider receives the merged context (Go: `FlattenedContext` with `"targetingKey"`). Reserved keys (`fireweave.*`) are stripped from person_properties mapping or passed through per ADR-0002; they must not collide with user attribute names — document reserved set in `evaluation-context.schema.json`.

### Spec baseline

- **Compliance floor:** OpenFeature specification **v0.8.0**.
- Build to **shipped SDK behavior**: SDK synthesizes READY/ERROR from `initialize` outcome (not provider-emitted init events from draft §2.8).
- Pins: Node `@openfeature/server-sdk` 1.22.0 (peer `@openfeature/core` ^1.11); Python `openfeature-sdk` `>=0.10,<0.11`; Go `go-sdk` v1.17.2; Java `dev.openfeature:sdk` **1.15.1** (see superseded-pins errata).
- Conformance: Appendix B `evaluation.feature` against Fireweave+InMemory; diff vs official in-memory provider oracle.

### Superseded pins (errata, 2026-07-27)

| Original pin in this ADR | Status | Current truth |
|---|---|---|
| Java `dev.openfeature:sdk` **1.21.0** | **Superseded** (orchestrator ruling 10) | **1.21.0 does not exist** on Maven Central. Live pin is **1.15.1** (newest published at research time). See `docs/compatibility.md` / `docs/openfeature.md`. |

### Provider contract (phase one)

Implement in all four languages:

1. Typed resolvers (Node: single number; Python/Go/Java: int+float; Java: override `getLongEvaluation`).
2. Metadata `name: "fireweave"`.
3. Lifecycle: `initialize` + shutdown (`onClose` Node; `ContextAwareStateHandler` Go).
4. Event emission for CONFIG_CHANGED / STALE / ERROR on adapter health (via per-language lifecycle notifier).
5. Map Fireweave errors → OF codes (ADR-0001 §12).
6. Empty provider hooks list initially; telemetry hooks opt-in and separately importable.

Do **not** implement deprecated provider `status`/`getState` members.

### Experimental quarantine

| Feature | Policy |
|---|---|
| Tracking §6 | Implement `track` → adapter capture bridge; `@experimental`; core eval independent |
| Transaction context §3.3 | Document SDK usage only; no Fireweave API dependency |
| Multi-provider | Compatible where OF ships it; untested on Python; not required |
| Isolated API instances §1.8 | No global Fireweave singleton; ignore until widely shipped |
| `domainScoped` / `initialize(_, domain)` | Do not declare domainScoped; ignore domain param |
| Provider-emitted init events (draft) | Lifecycle notifier abstraction; stay on SDK-synthesized events |
| Python 0.x | Compat shim module; pin `<0.11` |

### Hooks are not for smuggling extensions

**Forbidden:**

- Using before/after hooks as the only way to access Fireweave release/signal APIs
- Requiring proprietary hook hints for correct flag evaluation
- Encoding FireweaveClient features into hook `flagMetadata` as a substitute for public APIs

**Allowed:**

- Opt-in OTel/logging hooks that observe evaluation details
- Before-hooks that enrich standard evaluation context (merged by OF)
- Additive `flagMetadata` keys under `fireweave.*` for decision enrichment (reason, requestId, quota) — never required for reading the flag value

Extension functionality MUST remain callable via `FireweaveClient` without any hooks registered.

## Consequences

- Positive: clear mental model; OF ecosystem tools work; eject-to-raw-OF remains conceivable.
- Negative: some Fireweave details require the client API in addition to OF getters.
- Neutral: deploy-sdk eject story aligns (leave OF wiring).

## References

- `docs/research/openfeature-compatibility.md`
- OpenFeature spec v0.8.0 §§1–5
- ADR-0001, ADR-0002
