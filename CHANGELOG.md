# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (see [docs/versioning.md](docs/versioning.md) for the 0.x stability policy).

## [Unreleased]

Initial pre-release state of the repository. **Nothing has been published to any package registry.**

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
