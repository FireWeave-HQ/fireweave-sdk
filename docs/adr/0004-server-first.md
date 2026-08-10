# ADR-0004: Server-First Scope

- **Status:** Accepted
- **Date:** 2026-07-27
- **Deciders:** Agent D (Architecture & API lead)
- **Tags:** scope, security, server, browser, mobile

## Context and Problem Statement

Fireweave's product surface includes server, web, and future mobile/harness surfaces (`SURFACE_REGISTRY`). Local evaluation requires secret keys (`phs_`/`phx_`). Shipping browser or mobile packages in phase one would risk secret leakage, expand the matrix (web OF SDK, posthog-js), and dilute the polyglot server conformance goal. Proprietary `@fireweaveai/deploy-sdk` already has a web facade — design reference only.

## Decision Drivers

- Secret keys must never ship in frontend bundles
- Four server languages already stretch phase-one capacity
- Rollout harness prod path is server-shaped (`ts-server`, future `python`/`go`/`java`)
- Clear security boundary for OSS release

## Decision Outcome

**Phase one is server-only.**

### In scope

- Node.js (≥20), Python (≥3.10), Go (1.25 toolchain), Java (≥11) **server** SDKs
- `@openfeature/server-sdk` / server OF SDKs only
- PostHog **server** SDKs (`posthog-node`, `posthog`, `posthog-go`, `posthog-server`)
- Remote and local evaluation modes on trusted servers
- InMemory adapter, conformance, deploy-attestation/beacon client APIs (`releases.setContext` + `releases.start`) suitable for server boot

### Out of scope (phase one)

- Browser / `@openfeature/web-sdk` / `posthog-js`
- React Native, iOS, Android, Flutter/Dart
- Edge workers **unless** they can hold secrets safely and use server SDK patterns (not packaged as browser SDK)
- Automatic GeoIP from client IP as a Fireweave feature

### Security rules

1. **Secret keys (`phs_`, `phx_`, `FW_PROJECT_API_KEY`) never in frontend.** Local evaluation is server-only.
2. `phc_` is public-by-design for PostHog but Fireweave phase-one packages still target server runtimes; do not publish a browser build that encourages embedding server providers.
3. Docs and examples use environment variables (`POSTHOG_PROJECT_API_KEY`, `POSTHOG_HOST`, `FW_ATTEST_URL`, `FW_PROJECT_API_KEY`) — never hardcoded secrets.
4. Package metadata should mark server intent where ecosystems allow (`runsOn = 'server'` on Node provider).

### Future work (explicitly deferred)

| Item | Notes |
|---|---|
| ~~Browser package~~ | **Superseded by [ADR-0009](0009-browser-control-points.md)** (2026-08-09) — shipped as `@fireweaveai/web-sdk`, remote-only, no secret keys, no `posthog-js`. The rest of this ADR stands: mobile, Dart, and edge remain out of scope |
| Mobile | No prior art; greenfield after server GA |
| Dart surface | Enum exists in internal registry with `NO_PROD_VENDORS`; not this repo's phase one |
| Upstream `java` harness surface | File against main FireWeave `SURFACE_REGISTRY` / manifest schemas |
| Edge / WASM | Evaluate separately; secret handling is the gate |

## Consequences

- Positive: focused conformance matrix; clear secret boundary; aligns with PostHog local-eval constraints.
- Negative: web apps keep using proprietary deploy-sdk or raw OF+posthog-js until a future package.
- Neutral: architecture (Option 2) remains compatible with a later web runtime that shares schemas but not secret-bearing adapters.

## References

- `docs/research/repository-assessment.md` §7
- ADR-0001, ADR-0002
- PostHog local evaluation docs (secret key requirement)
