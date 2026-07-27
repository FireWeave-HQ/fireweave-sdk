# Fireweave SDK — Orchestration Ledger

## Phase 0 baseline (recorded 2026-07-27)

- Repository: `/Users/niketh/Coding/fireweave-sdk/Untitled` (new, empty at start)
- Current commit at start: **none** (fresh `git init`, branch `master`, no commits)
- Existing tests: **none** (empty repository — no baseline failures to record)
- Related existing repositories (read-only inputs for research):
  - `/Users/niketh/Coding/Fireweave` — main Fireweave codebase
  - `/Users/niketh/Coding/fireweave-data-engine`
  - `/Users/niketh/Coding/Fireweave-gitops`, `/Users/niketh/Coding/fireweave-dataplane-gitops`
  - `/Users/niketh/Coding/Fireweave-slackbot`, `/Users/niketh/Coding/FireTunnel`

## Agent roster

| Agent | Mission | Owned paths | Branch | Depends on | Required outputs | Status | Merge order |
|---|---|---|---|---|---|---|---|
| A — Repository archaeologist | Assess existing Fireweave repos; recommend SDK repo location/packaging | `docs/research/repository-assessment.md` | `research/repo-assessment` | — | Repo map, conventions, constraints, ownership boundaries, risks | **complete** | 1 (research, no code) |
| B — OpenFeature standards researcher | Current OpenFeature spec + official SDKs for TS/Python/Go/Java | `docs/research/openfeature-compatibility.md` | `research/openfeature` | — | Feature matrix, provider contract, stable baseline, conformance strategy, version pins | **complete** | 1 |
| C — PostHog platform researcher | Official PostHog SDKs + OpenFeature providers for 4 languages | `docs/research/posthog-sdk-matrix.md` | `research/posthog` | — | Capability matrix, per-language wrap-vs-delegate recommendation, lifecycle/testing/security notes | **complete** | 1 |
| D — Architecture & API lead | ADRs, architecture, public API, spec schemas | `docs/architecture.md`, `docs/adr/`, `spec/` | `design/architecture` | A, B, C | ADRs 0001–0004, `spec/*.schema.json` | **complete** | 2 |
| E — Contract & conformance lead | Fixtures, error taxonomy, conformance harness | `contracts/`, `test-server/` | `design/contracts` | A, B, C (parallel w/ D) | Canonical fixtures, error taxonomy, harness spec | **complete** | 3 |
| F — TypeScript/Node | Node runtime, provider, adapters, extensions | `sdks/node/`, `examples/node/` | `impl/node` | D, E | Passing contract+conformance tests | pending | 4 |
| G — Python | Python runtime, provider, adapters, extensions | `sdks/python/`, `examples/python/` | `impl/python` | D, E | Passing contract+conformance tests | pending | 5 |
| H — Go | Go runtime, provider, adapters, extensions | `sdks/go/`, `examples/go/` | `impl/go` | D, E | Passing contract+conformance tests | pending | 6 |
| I — Java | Java runtime, provider, adapters, extensions | `sdks/java/`, `examples/java/` | `impl/java` | D, E | Passing contract+conformance tests | pending | 7 |
| J — Security & privacy reviewer | Threat model, privacy policy, security tests | `docs/security/`, `docs/privacy.md` | `review/security` | F–I APIs stable | Threat model, redaction rules, release blockers | pending | 8 |
| K — CI/packaging/release | CI workflows, release automation | `.github/`, `scripts/`, `tools/` | `infra/ci` | F–I APIs stable | Green CI matrix, release dry runs, no publishing | pending | 8 |
| L — Docs & DX | User-facing docs, tested examples | `docs/` (non-research/adr/security), root community files | `docs/dx` | F–I APIs stable | Docs meeting acceptance criteria §15 | pending | 8 |
| M — Adversarial reviewer | Skeptical integrated review | `docs/reviews/adversarial-review.md` | `review/adversarial` | Phase 5 integration | Findings by severity; blockers resolved | pending | 9 |

## Ownership rules

- No two implementation agents modify the same file concurrently.
- Canonical schema/fixture changes go only through Agent E with orchestrator approval.
- Research agents (A/B/C) write only their own file under `docs/research/`.

## Phase log

- **Phase 0** (complete): baseline recorded; ledger created; initial commit made.
- **Phase 1** (complete): Agents A, B, C delivered research; orchestrator decision brief at `docs/orchestration/decision-brief.md` (commit a272c64).
- **Phase 2** (in progress): Agents D (architecture/ADRs/spec) and E (contracts/fixtures/test-server) running in parallel with disjoint ownership.

## Orchestrator arbitration (Phase 2 exit, 2026-07-27)

Resolving Agent D (spec/) vs Agent E (contracts/) divergences. Canonical rule: `spec/` schemas are the source of truth; fixtures conform to spec.

1. **Context bounds (canonical):** attr count **128**, key **256 B**, value **4 KiB**, nesting depth **6**, serialized context **64 KiB** (adopt D's spec values; E fixtures updated).
2. **Error taxonomy (canonical):** the full 15-kind PascalCase taxonomy required by the project brief §11 (NotReady, FlagNotFound, TypeMismatch, InvalidContext, Authentication, Authorization, RateLimited, Timeout, Network, BackendUnavailable, MalformedResponse, UnsupportedCapability, Configuration, AlreadyClosed, Internal) — spec/errors.schema.json updated to E's richer set; kind names PascalCase, languages map idiomatically.
3. **AlreadyClosed → OpenFeature `PROVIDER_NOT_READY`** (not GENERAL); Fireweave kind preserved in decision metadata. E fixtures updated.
4. **quotaLimited:** confirmed — treated as flag-not-found default resolution with metadata key `fireweave.quotaLimited: true`.
5. **Extension API shapes:** `contracts/extensions/*` fixtures must match the public API sketch in `docs/architecture.md` (releases.setContext/start/complete/fail; exposures.record/flush; signals.recordHealth/recordError/recordMetric/recordOutcome; capabilities.get). Divergences fixed on the fixtures side unless the sketch is ambiguous — then flagged.

## Orchestrator ruling 6 (Phase 2 exit, follow-up)

6. **Extension API surface (final):** canonical shapes are `releases.setContext/start/complete/fail`, `exposures.record/flush`, `signals.recordHealth/recordError/recordMetric/recordOutcome`, `capabilities.get` (per project brief candidates; already encoded in the 13 extension fixtures). `docs/architecture.md` §6 must be updated to these shapes (replacing attest/current, track/setPolicy, emit); deploy-attestation semantics are carried by `releases.setContext` + `releases.start`. `spec/signal.schema.json` must be reconciled to the fixture signal model (kind: health|error|metric|outcome, status, optional timestamp for deterministic fixtures). Capability strings updated to match final method names and include `capabilities.get`.

Phase 2 exit checklist: **8/8 PASS** (see reconciliation report). Phase 3 authorized upon ruling-6 application.

## Orchestrator rulings 7–9 (Phase 2 close-out)

7. **Release identifiers:** `spec/release-context.schema.json` is canonical — `stampIds` is an ARRAY of `stmp_<26-char Crockford ULID>`; `changeId` uses the 26-char pattern. The four `ext-releases-*` fixtures are regenerated with valid 26-char ULIDs and the array shape.
8. **flagMetadata scalars:** OpenFeature's scalar-only flagMetadata contract is canonical (`decision.schema.json` unchanged). `eval-payload-attached` expects `fireweave.payload` as a JSON-*string* serialization of the payload; structured payloads are otherwise delivered as the object-flag value itself.
9. **Typed ID naming:** accepted — extension/release shapes use the established `rolloutId`/`changeId`/`stampId` names (not generic releaseId/deploymentId).

- **Phase 2** (complete, commit pending): D + E delivered; rulings 1–9 applied; exit checklist 8/8 PASS; spec/ ↔ contracts/ fully consistent and machine-validated.
- **Phase 3** (in progress): Agents F (Node), G (Python), H (Go), I (Java) launched in parallel. Each owns only `sdks/<lang>/` + `examples/<lang>/` (F additionally implements `test-server/implementation/` per E's plan). Canonical schema/fixture changes remain orchestrator-gated.

## Orchestrator ruling 10 (Phase 3, research correction)

Verified against Maven Central (2026-07-27, live query): `dev.openfeature:sdk` latest is **1.15.1** (research's 1.21.0 does not exist) and **`com.posthog:posthog-server` is not published** (only `com.posthog:posthog`/`posthog-android` 3.19.1 for Android). Agent B/C's Java-column pins were incorrect; decision brief §3 amended. Rulings:
- Java builds against `dev.openfeature:sdk:1.15.1`.
- PostHogAdapter (Java) ships behind Agent I's `PostHogClientApi` seam with a clear `UnsupportedCapability` on `create(config)` until PostHog publishes a server SDK with local evaluation; whether to interim-bind legacy `com.posthog.java:posthog` 1.2.0 (remote-only) is deferred to Phase 5 + adversarial review as a known limitation.
- Node/Python/Go pins stand — they were validated by real installs during Phase 3.

## Orchestrator rulings 11–12 (Phase 3 close-out)

11. **Vendor-metadata gating RATIFIED:** `fireweave.vendorFlagId` and `fireweave.reasonCode` are emitted only when the backend reports BOTH a vendor flag id and a condition index (independently converged on by Agents F, G, I from fixture triangulation). To be codified in `contracts/README.md` + `spec/decision.schema.json` description during Phase 5 integration.
12. **Reserved-key carve-out RATIFIED:** `fireweave.groups` and `fireweave.groupProperties` are the only permitted `fireweave.*` context keys; spec to name them explicitly in Phase 5.

- **Phase 3** (complete): F/G/H/I all green. Node: 67 unit + 15 integration, conformance 61/63 (2 pre-ratified skips). Python: 196 tests, 63/63. Go: 64 tests + 80 subtests (-race), 63/63. Java: 71 tests, 62/63 (1 pre-ratified skip). test-server stub implemented (Node, zero-dep). Phase 5 queue: re-run G/H/I fault fixtures against the HTTP stub; codify rulings 11–12; Java interim PostHog binding decision; H's $-prefix stripping + WithIncludePayload documentation.
- **Phase 4** (in progress): Agents J (security/privacy), K (CI/packaging/release), L (docs/DX) launched in parallel.

## Agent J results + ruling 13 (Phase 4)

Security review: **0 release blockers, 2 HIGH, 5 MEDIUM, 6 LOW** (see docs/security/release-blockers.md). Per project policy, HIGH findings must be fixed before final acceptance. Phase 5 fix queue (assigned to integration wave):
- H-1: default-on host allowlist in Node + Python, ONE canonical default list across all four languages, https-only for non-loopback.
- H-2: Node fixed outward error messages (use safeMessage; no vendor-text interpolation).
- Secure defaults: enforced shutdown deadline from config in Node/Python/Java; Node telemetry allowlist default-on; exposure-dedup clear-on-flush everywhere (adopt Python's lifecycle); explicit vendor retry/queue caps in Python.

13. **`fireweave.*` carve-out enforcement (extends ruling 12):** ALL four languages must accept exactly `fireweave.groups` + `fireweave.groupProperties` and reject other `fireweave.*` keys. Python's unratified `fireweave.evaluationContexts` is REJECTED — remove it. A conformance fixture should pin this (contracts change via orchestrated review).

## Agent K results (Phase 4)

CI/packaging/release delivered and locally verified: test-all (Node 82, Python 196, Go -race, Java 71, 4 offline examples), conformance-all 63-fixture matrix with comparator (0 undeclared divergences), build-all dry-run artifacts + SHA256SUMS. Publishing HARD-DISABLED. Phase 5 fix queue additions:
- Python: 4 pyflakes findings (baselined in tools/lint/python-baseline.txt — fix and remove baseline entries).
- Python: remove committed src/fireweave.egg-info/ and gitignore it.
- Go: delete committed binary examples/go/go and gitignore it.
- Reconcile .github/ISSUE_TEMPLATE ownership: K created templates while L was also assigned them — merge at L completion.
