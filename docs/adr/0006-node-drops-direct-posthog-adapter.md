# ADR-0006: The Node SDK drops the direct PostHog adapter

- **Status:** Accepted
- **Date:** 2026-08-08
- **Scope:** `sdks/node` only. Python, Go, and Java keep their adapters for now; ADR-0002 remains in force for them.
- **Supersedes (Node only):** [ADR-0002](0002-posthog-adapter.md)
- **Related:** ADR-0005 (Fireweave proxy backend — now the only backend), ADR-0007 (control-point vocabulary), ADR-0008 (multi-runtime support)

## Context and Problem Statement

ADR-0005 made `FireweaveRemoteAdapter` the production path: applications hold a Fireweave project key and talk to fw-server, which resolves the project's connected provider and forwards. The direct `PostHogAdapter` was kept as "an advanced escape hatch".

That escape hatch cost more than it returned:

- **It leaked the backend into the product surface.** `@fireweaveai/sdk/posthog`, a `posthog-node` peer dependency, `phc_`/`phs_`/`phx_` key documentation, `posthog` in the `backend` and `BackendAdapter['name']` unions, `posthogAdapter` in the capability matrix, and five `*.posthog.com` entries hardcoded in the default host allowlist. A user reading the SDK learned which vendor Fireweave uses — something they should not need to know or care about.
- **It was 555 lines of vendor-compensation logic.** An injected `fetch` observer existed only because `posthog-node` swallows `/flags` transport errors and returns empty snapshots. Snapshot reads had to go through internal `_flags` records because `getFlag`/`isEnabled` emit `$feature_flag_called` unconditionally and ignore `sendFeatureFlagEvent`. Owned clients needed a capture gate to drop vendor auto-exposures. None of this hazard exists on the Fireweave protocol.
- **It tied the package to one runtime.** `posthog-node` as a peer dependency is the kind of thing that makes "runs on Deno" a claim you cannot make cheaply (see ADR-0008).

## Decision

Delete the direct PostHog adapter from the Node SDK.

Removed: `src/adapters/posthog.ts`, the `./posthog` export subpath, the `posthog-node` peer dependency, both PostHog test files, the `adapterName === 'posthog'` branch in `validateConfig`, `posthogAdapter` from the capability matrix, and `'posthog'` from the two type unions.

`DEFAULT_ALLOWED_HOSTS` swaps the five vendor hostnames for `app-server.fireweave.ai` and `staging-app-server.fireweave.ai` plus loopback. The security property is unchanged — an unconfigured allowlist still denies everything it does not name — but the contents changed, so code composing on top of the exported constant no longer reaches the former vendor endpoints. That is the intent.

The `posthog` string must now appear **nowhere** in the published build, including comments. `test/unit/no-vendor-leak.test.ts` enforces this absolutely, with no carve-out. (v2 allowed one: the adapter itself, provided it loaded the vendor lazily.)

## Capability actually lost

**In-process local evaluation.** The PostHog adapter supported a secret key (`phs_`/`phx_`) that enabled background definition polling, `onlyEvaluateLocally` serving, definitions-staleness detection, and a `waitForLocalDefinitions` readiness gate. No shipped Node adapter offers that now; both report `localEvaluation: false`. Caching is fw-server's concern.

This is accepted, not overlooked. Two consequences follow:

1. **The interface seam is deliberately preserved.** `AdapterRuntimeFeatures.localEvaluation` / `localOnly`, `AdapterResolution.fromCache`, and the `STALE` decision reason all remain in `adapter.ts`, unused by shipped adapters, so a future Fireweave-native cache reports through the same fields rather than inventing new ones. `test/compat/v2-types.compat.ts` pins them.
2. **Nothing needed copying out of the deleted file.** `PostHogClientLike`, `EvaluateFlagsSnapshot`, and `SnapshotFlagRecord` were vendor-shape mirrors with no other consumer. The vendor-neutral equivalents (`quotaLimited`, `fromCache`, `version`, `vendorFlagId`, `reasonCode`, `conditionIndex`) already existed and are already populated by fw-server over `/v1/flags/evaluate`.

## Conformance impact

The nine `contracts/faults/*` fixtures ran through `PostHogAdapter` against the test-server's vendor routes. They now run through `FireweaveRemoteAdapter` against `POST /v1/flags/evaluate`, fault scope `evaluate`. All nine pass with no adapter changes — the HTTP-status mappings were already identical.

One additive test-server change: the `quota_limited` fault serves the Fireweave shape on the `evaluate` scope and the vendor shape elsewhere. Serving the vendor body on `/v1` would surface as a parse failure rather than a quota signal. The vendor routes are untouched, because Python, Go, and Java conformance still drives them.

**Fidelity note, stated rather than glossed:** these fixtures used to exercise a real vendor client through an injected fetch observer; they now exercise a direct `fetch` against a stub. That is thinner in kind — but the observer existed to compensate for a vendor hazard that `FireweaveRemoteAdapter` does not have. Net simplification with no loss of asserted behavior.

## Breaking changes

Three, all listed separately in the CHANGELOG so a reader can tell in seconds whether they are affected:

| Break | Affects |
| --- | --- |
| `@fireweaveai/sdk/posthog` no longer resolves | apps importing `PostHogAdapter` |
| `posthog-node` peer dependency removed | apps relying on the SDK to declare it |
| `'posthog'` dropped from `BackendAdapter['name']` and `Capabilities['runtime']['backend']` | custom-adapter authors; exhaustive switches |

Everything else a consumer touches is unchanged — see ADR-0007 and `test/compat/`. The consumer-facing migration guide is the [Node module README](../../sdks/node/packages/sdk/README.md#upgrading-from-v20-to-21), which ships on the npm package page.

## Follow-ups

- Python, Go, and Java each need their own pass and their own ADR. Until then `docs/posthog.md` documents the adapter for three languages while Node's entry says it was removed; `docs/compatibility.md` records that asymmetry so it reads as deliberate.
- `spec/decision.schema.json` still names `fireweave.vendorFlagId`. The value is fw-server's, so the field is vendor-neutral in substance, but the word invites the question. Renaming it is a four-language spec change — deliberately out of scope.
