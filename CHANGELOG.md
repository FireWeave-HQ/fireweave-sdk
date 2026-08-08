# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (see [docs/versioning.md](docs/versioning.md) for the 0.x stability policy).

## [Unreleased]

**Nothing has been published to any package registry.**

### Node SDK `@fireweaveai/sdk` 3.0.0 — 2026-08-08

Node-only release. The Python, Go, and Java SDKs are unchanged and remain at `0.1.0`.

#### Breaking

Exactly three things break. Everything else a consumer touches is unchanged — see *Not breaking* below.

1. **`@fireweaveai/sdk/posthog` no longer resolves.** The direct vendor adapter was removed ([ADR-0006](docs/adr/0006-node-drops-direct-posthog-adapter.md)). Replace `PostHogAdapter` with `FireweaveRemoteAdapter`; env vars `POSTHOG_HOST`/`POSTHOG_API_KEY` become `FW_API_URL`/`FW_PROJECT_API_KEY`. One-line change; full guide in the [Node module README](sdks/node/packages/sdk/README.md#upgrading-from-v2-to-v3), condensed cross-language view in [docs/migration.md](docs/migration.md#from-fireweaveaisdk-v2-to-v3-node).
2. **`posthog-node` is no longer a peer dependency.** If you use it for your own analytics, depend on it directly.
3. **Type-level:** `'posthog'` is no longer a member of `BackendAdapter['name']` or `Capabilities['runtime']['backend']`. Affects custom adapters declaring `name: 'posthog'` (use `'other'`) and exhaustive switches on `backend`.

#### Removed capability

**In-process local evaluation.** The vendor adapter's secret-key mode (background definition polling, `onlyEvaluateLocally`, staleness detection, `waitForLocalDefinitions`) has no replacement; caching is fw-server's concern and both shipped adapters report `localEvaluation: false`. The interface seam (`AdapterRuntimeFeatures.localEvaluation`/`localOnly`, `AdapterResolution.fromCache`, the `STALE` reason) is deliberately preserved for a future Fireweave-native cache. If in-process evaluation is load-bearing for you, stay on v2 and tell us.

#### Not breaking (deliberately)

- `client.flags` still exists and **is** `client.controlPoints` — same object, not a copy. Marked `@deprecated` in JSDoc only; **not scheduled for removal in v3**. Renaming is cosmetic and can be deferred indefinitely.
- `capabilities.get().static.features.flags` is still `true` (`controlPoints: true` added beside it).
- `InMemoryAdapterOptions.flags`, `FlagValueType`, `InMemoryFlagDefinition`, `ExpectedFlagType`, `Decision.flagKey`, `Exposure.flagKey`, `flagMetadata` — all unchanged.
- All 22 v2 value exports and ~40 type exports survive, pinned by `packages/sdk/test/compat/v2-surface.compat.test.ts` and `v2-types.compat.ts`.

#### Added

- **"Control point" is the product noun** ([ADR-0007](docs/adr/0007-control-point-vocabulary.md)). `client.controlPoints` is the documented namespace. `flagKey` stays at four fixed boundaries — the OpenFeature API, the wire protocol, `spec/*.schema.json`, and the `features.flags` capability — each fixed by something outside this repo. The ADR records exactly where each term applies, so the duality is a decision rather than an unfinished refactor.
- **Bun ≥ 1.2 and Deno ≥ 2.0 support**, gated in CI ([ADR-0008](docs/adr/0008-multi-runtime-support.md), [docs/runtimes.md](docs/runtimes.md)). `Buffer.byteLength` → `TextEncoder`; direct `process.env` reads → a guarded `readEnv()` that treats a denied Deno `--allow-env` as absence rather than failure.
- **`FW_DEPRECATION_WARNINGS=1`** — opt-in, one notice per process when the `client.flags` alias is used. Silent by default: a per-call warning at request volume is how deprecation notices get suppressed wholesale.
- **`scripts/smoke-runtimes.mjs`** — one cross-runtime smoke, run unchanged on Node, Bun, and Deno; wired into `npm run verify`.
- **New guard tests:** `runtime-portability.test.ts` (bans `Buffer.`, bare `process.env`, and `node:` imports in `src/`), and a check that `SDK_VERSION` matches `package.json#version` — those two had silently drifted apart in v2 (`0.1.0` vs `2.0.0`).

#### Changed

- **`DEFAULT_ALLOWED_HOSTS` contents changed** while the export name stayed. It now lists `app-server.fireweave.ai`, `staging-app-server.fireweave.ai`, and loopback — not vendor hosts. Code doing `allowedHosts: [...DEFAULT_ALLOWED_HOSTS, …]` keeps compiling and silently stops permitting the old endpoints. Intended; verify against your deployment.
- `capabilities.get().static.sdkVersion` now reports the real package version.
- `features.posthogAdapter` → `features.remoteAdapter`.
- The vendor-leak guard is now absolute: `posthog` must appear **nowhere** in the published build, including comments. v2 allowed one carve-out for the adapter itself.
- Node's fault-conformance suite runs through `FireweaveRemoteAdapter` against `POST /v1/flags/evaluate` instead of the vendor routes. All 9 fixtures pass unchanged; the other three languages still drive the vendor routes. The test server gained a Fireweave-shaped `quota_limited` response for the `evaluate` scope (additive; vendor routes untouched).
- **`spec/`** enums widened, never narrowed: `controlPoints`/`remoteAdapter` added to capability features, `fireweave` added to `backendsPhaseOne`. `posthog` remains a valid value everywhere because Python and Go still report it.

#### Docs

README rewritten around the release-engineering surface with OpenFeature as one section rather than the premise. New `docs/runtimes.md`, ADRs 0006–0008. ADR-0002 marked partially superseded (Node only). `docs/posthog.md` rescoped to Python/Go and its Node section replaced with a removal notice. `docs/privacy.md` corrected — it cited line numbers in the deleted adapter, and claimed Node's telemetry allowlist was opt-in when it has been on by default since M-3.

---

### Initial pre-release state

### Added

- **Canonical spec (`spec/`, v0.1.0)** — JSON Schemas (draft 2020-12) for evaluation context, decision, release context, signal, capabilities, and the 15-kind error taxonomy; OpenFeature spec compliance floor v0.8.0.
- **Conformance contracts (`contracts/`)** — 63 cross-language fixtures across evaluation, context, lifecycle, faults, security, and extensions suites; canonical error taxonomy (`errors.md`/`errors.json`); harness contract with normalization and CI-gating rules; ratified context bounds (128 attributes / 256 B keys / 4 KiB values / depth 6 / 64 KiB serialized).
- **Node SDK (`sdks/node`, `@fireweaveai/sdk`, unpublished)** — OpenFeature server provider (`@openfeature/server-sdk` 1.22.0), `FireweaveRuntime`/`FireweaveClient`, `InMemoryAdapter`, PostHog adapter over `posthog-node` 5.46.1 behind the `./posthog` subpath. 67 unit + 15 integration tests; conformance 61/63 (2 documented numeric skips: single `number` resolver).
- **Python SDK (`sdks/python`, `fireweave`, unpublished)** — zero-dependency core, `fireweave[posthog]` (posthog 7.31.0) and `fireweave[openfeature]` (openfeature-sdk >=0.10,<0.11) extras, sync runtime + `fireweave.aio.AsyncFireweaveClient`. 196 tests; conformance 63/63.
- **Go SDK (`sdks/go`, module `github.com/FireWeave-HQ/fireweave-sdk/sdks/go`)** — `fireweave`, `openfeature` (go-sdk v1.17.2), `adapters/inmemory`, `adapters/posthog` (posthog-go v1.22.0) packages; race-tested. 64 tests + 80 subtests; conformance 63/63.
- **Java SDK (`sdks/java`, `ai.fireweave:*`, unpublished)** — four Maven modules (`fireweave-sdk`, `fireweave-openfeature` on `dev.openfeature:sdk` 1.15.1, `fireweave-adapter-posthog`, `fireweave-testing`), Java 11+. 71 tests; conformance 62/63 (1 documented skip: 32-bit integer resolver range).
- **Fireweave extension APIs** in all four languages: `releases.setContext/start/complete/fail`, `exposures.record/flush`, `signals.recordHealth/recordError/recordMetric/recordOutcome`, `capabilities.get`, and a phase-one `guardrails` stub that degrades with `UnsupportedCapability`.
- **Test server (`test-server/`)** — deterministic, zero-dependency Node stub of the PostHog server protocol (`/flags?v=2`, definitions poll, `/batch/`) with scriptable fault modes.
- **Examples (`examples/`)** — runnable Node, Python, Go, and Java walkthroughs, offline by default.
- **Documentation** — architecture + ADRs 0001–0004, user docs under `docs/`, community files.

### Known limitations

- Java's PostHog adapter cannot be constructed from config alone (`UnsupportedCapability`) until PostHog publishes a Java server SDK with local evaluation; use the `PostHogClientApi` injection seam.
- Guardrails are a typed stub in every language (phase one).
- Package names and the MIT license await company ratification; publication is gated.

[Unreleased]: https://github.com/FireWeave-HQ/fireweave-sdk/compare/master...HEAD
