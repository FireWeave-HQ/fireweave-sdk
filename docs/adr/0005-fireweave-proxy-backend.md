# ADR-0005: Fireweave-authenticated proxy backend (fw-server)

- **Status:** Accepted (direction change)
- **Date:** 2026-07-27
- **Deciders:** Product / platform (niketh); orchestrator records
- **Supersedes (production path):** ADR-0002's assumption that customer apps hold PostHog `phc_`/`phs_`/`phx_` keys and call PostHog directly
- **Related:** ADR-0001 (BackendAdapter), ADR-0002 (PostHogAdapter — demoted to optional/direct escape hatch), ADR-0004 (server-first)

## Context and Problem Statement

Phase-one SDKs wrap official PostHog SDKs and expect PostHog credentials in the application. The product requirement is:

1. Applications configure a **Fireweave key/secret**, never a PostHog key.
2. All runtime flag evaluation, definitions polling, and event/exposure capture go to **fw-server** (`apps/fw-server`).
3. fw-server is a **thin proxy / control plane** that resolves the project's connected provider credentials and forwards to PostHog (today) or another provider (tomorrow).
4. Changing the underlying vendor must not require application SDK changes or redeploying customer PostHog keys.

Research of the main monorepo (2026-07-27) shows **no** Fireweave-auth → PostHog evaluate/capture proxy exists yet. Today:

- `POST /v1/attest` accepts `FW_PROJECT_API_KEY` (`project-api-key_…`) for boot beacons only.
- Customer apps evaluate flags **directly** against PostHog with `POSTHOG_*` / `PUBLIC_POSTHOG_*`.
- Control-plane `integration-posthog` can hit `/flags?v=2` via session/NATS — not an SDK runtime path.

## Decision Drivers

- Vendor independence for customers (PostHog is an implementation detail of Fireweave's backend).
- Credential hygiene: PostHog personal/secure keys never leave Fireweave infrastructure.
- Existing `BackendAdapter` boundary already anticipated a future `FireweaveRemoteAdapter`.
- Preserve OpenFeature public API and FireweaveClient extensions.
- Keep InMemoryAdapter for tests/examples offline.

## Decision Outcome

**Production default backend is `FireweaveRemoteAdapter` (name TBD; package surface: Fireweave-hosted remote backend).** It:

- Authenticates with a **Fireweave project credential** (reuse/extend `FW_PROJECT_API_KEY` / `project-api-key_…` or a dedicated runtime key with scopes beyond `attest:write` — exact key type owned by fw-server).
- Speaks only to **fw-server base URL** (`FW_ATTEST_URL` / `FW_API_URL` — finalize naming).
- Never depends on PostHog SDKs or PostHog hosts in the customer process for the default path.
- Implements `BackendAdapter` so OpenFeature + FireweaveClient stay unchanged.

**fw-server** (main monorepo) must add thin proxy routes, roughly:

| SDK need | Proposed fw-server surface (sketch) | Upstream today |
| --- | --- | --- |
| Evaluate flags | `POST /v1/flags/evaluate` (or `/v1/flags`) | PostHog `/flags?v=2` via stored connection |
| Local-eval definitions (optional phase) | `GET /v1/flags/definitions` | PostHog local-eval definitions API |
| Capture / exposures / signals | `POST /v1/events` or `/v1/capture` | PostHog capture/batch |
| Auth | Bearer Fireweave project/runtime key → resolve org/project → provider connection | Vault / integration-posthog credentials |

Provider selection and credential storage stay on fw-server. Swapping PostHog for another vendor is an fw-server + integration change, not an SDK release.

### Role of PostHogAdapter (ADR-0002)

| Mode | Status |
| --- | --- |
| **Default production** | **Fireweave remote / proxy adapter** |
| **PostHogAdapter** | Optional **advanced/direct** escape hatch for Fireweave-internal dogfood, migration, or customers who explicitly want direct PostHog — must remain clearly labeled PostHog-specific; not the documented quickstart |
| **InMemoryAdapter** | Unchanged — tests and offline examples |

Phase-one "wrap official PostHog SDKs" remains valid for the *direct* adapter and for fw-server's server-side forwarding implementation, but **not** as the customer-facing credential model.

## Consequences

### Positive

- Customers never handle `phc_`/`phs_`/`phx_`.
- Fireweave can change vendors without SDK API breaks.
- Aligns with attest/beacon already using `FW_*` env vars.
- Simplifies Java: no dependency on unpublished `posthog-server` for the default path.

### Negative / work required

- **fw-server routes do not exist yet** — blocking for real proxy-backed publish claims.
- Local evaluation semantics move: either fw-server caches definitions and serves evaluate, or the SDK does remote-only against fw-server initially (simpler; recommended for first cut).
- Latency: one extra hop (SDK → fw-server → PostHog).
- New auth scopes and rate limits on project keys.
- Docs/examples/`docs/posthog.md` quickstart must be rewritten to Fireweave credentials + proxy.
- Staging npm publish messaging must not imply "bring your PostHog key."

### Neutral

- OpenFeature provider interface unchanged.
- Contract fixtures against InMemoryAdapter unchanged.
- test-server stub can later emulate fw-server protocol instead of (or in addition to) PostHog.

## Implementation plan (ordered)

1. **fw-server (FireWeave monorepo):** design and ship `/v1/flags/evaluate` + `/v1/capture` (minimum) with Fireweave project-key auth and PostHog forwarding via existing integration credentials.
2. **spec/:** add Fireweave remote protocol schemas (request/response) under `spec/` — vendor-neutral wire format.
3. **SDK:** implement `FireweaveRemoteAdapter` (HTTP client, no PostHog SDK) in Node → Python → Go → Java; make it the documented default.
4. **Docs:** quickstart uses `FW_API_URL` + `FW_PROJECT_API_KEY`; move PostHog direct setup to "Advanced: direct PostHog adapter."
5. **CI:** integration tests against a fw-server protocol stub (evolve `test-server/`).
6. **Deprecate** documenting PostHog keys as the primary path; keep PostHogAdapter code until remote adapter is green.

## Open questions (fw-server ownership)

1. Reuse `project-api-key_…` with expanded scopes, or mint `fw_runtime_…` / similar?
2. Remote-only first vs. definitions proxy for local-eval parity?
3. Exact path prefix and versioning (`/v1/flags/...`)?
4. Whether exposures are Fireweave-normalized events (`$fw_exposure`) that fw-server maps to `$feature_flag_called`?

## References

- Main repo attest: `apps/fw-server/src/features/deploy-attestation/`
- Integration evaluate: `packages/integration-posthog/.../flag-evaluate.handler.ts`
- Polyglot architecture: `docs/adr/0001-sdk-architecture.md`, `docs/architecture.md`
