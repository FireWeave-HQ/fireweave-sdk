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

## Agent L results + orchestrator rulings 14–18 (Phase 4 close, Phase 5 open)

Docs/DX delivered: 9 root community files, 12 user docs, templates; all snippets executed against real SDKs; 10/10 acceptance criteria pass (Java criterion 2 honestly seam-qualified). Discrepancy rulings:

14. **Groups representation:** canonical context keys are `fireweave.groups` / `fireweave.groupProperties` (per spec + rulings 12–13). All four languages must accept them; idiomatic accessors (Java `.group()` builder, Go typed fields) are permitted sugar that MUST map onto the canonical keys; plain top-level `groups` is not canon (may remain as documented alias only if already public — prefer removal pre-release). New conformance fixture pins canonical-key acceptance in all languages.
15. **`releases.setContext` validation:** `spec/release-context.schema.json` required fields are canon; all four languages enforce exactly those (rolloutId required; stampIds per schema).
16. **Detailed-eval surface:** every language exposes detailed (Decision-returning) evaluation on the public client surface; naming is idiomatic (`client.flags.evaluate` / equivalent); Node must not require reaching into runtime. `docs/architecture.md` §6.3 amended to state behavioral—not lexical—requirement. `flags.evaluateMany` and `telemetry.configure` are REMOVED from the §6 sketch → follow-up backlog (unimplemented everywhere; scope stays bounded).
17. **Extension gating:** canonical behavior = Go/Java model: extension calls are lifecycle-gated and delivered to the adapter sink; pre-ready/post-shutdown calls degrade predictably (UnsupportedCapability/AlreadyClosed results, never throw). Node/Python align. Fixture pins it.
18. **`capabilities.get` shape:** `spec/capabilities.schema.json` structured matrix is canon; Python/Go align.

- **Phase 4** (complete): J (0 blockers, 2 HIGH queued), K (CI green locally, publish hard-disabled), L (docs complete).
- **Phase 5** (in progress): canon-update agent (contracts/spec/architecture per rulings 11–18) + four language fix agents in parallel; final verification wave after.

## Canon agent results + ruling 19 (Phase 5)

Rulings 11–18 codified; fixture inventory now **65** (new: ctx-fireweave-groups-carveout, ext-lifecycle-gating; multi-case `cases` format introduced — language runners must support it). release-context required set clarified to ["rolloutId","stampIds"].

19. **Plain `groups`/`groupProperties` alias RETAINED for phase one:** `ctx-person-and-groups` stands unchanged; canonical `fireweave.groups`/`fireweave.groupProperties` keys are the primary documented path, plain-alias removal is deferred to the follow-up backlog (avoids cross-language breakage mid-wave). No language may remove the alias in this wave.

- **Phase 5 fix wave** (complete): Node 85u+15i / 63+2sk; Python 238 / 65; Go 74+91sub (-race) / 65; Java 86 / 64+1sk. HIGH security fixes applied; rulings 13–18 implemented; faults re-run against HTTP stub (per-language residual modes documented). Full-matrix verification + Phase 6 adversarial review next.

## Agent M adversarial review (Phase 6) — NO-GO

3 release blockers, 8 high, 9 medium, 7 low, 5 future. See `docs/reviews/adversarial-review.md`.
Mandatory before acceptance: fix RB-1..RB-3 and all HIGH findings; re-run verification; re-review blockers.

**RB-1:** Node hybrid/local eval maps successful local serves to Network — fix error mapping.
**RB-2:** Node local snapshot path still emits `$feature_flag_called` despite claims — disable or gate correctly.
**RB-3:** Java `PostHogAdapter.create(config)` always UnsupportedCapability — either interim remote-only binding OR demote Java PostHog to explicitly unsupported in all public docs/examples/compatibility matrix (no false claims). Prefer honest unsupported + injection-only until PostHog publishes a server SDK, unless a safe remote-only legacy bind is trivial and tested.

## Phase 6 fix wave (post–Agent M)

- RB-1/RB-2 (Node) fixed — commit 8583b63
- RB-3 (Java) honest unsupported — commit 436039f
- H-2 (Node ULID) fixed in Node wave; H-7 (Java evaluationContexts) fixed in Java wave
- Cross-lang HIGH wave: H-1/H-3/H-4(Py+Go+docs)/H-5/H-6/H-8

**Ruling 20 (exposure default on evaluate):** Phase-one evaluate is **side-effect-free by default** (no automatic exposure emission). Callers opt in via `sendExposure: true` / language equivalent. Align Node to match Python/Go (default false). Fireweave still owns emission when opted in; vendor `$feature_flag_called` remains suppressed (RB-2). Update ADR/docs accordingly if needed.

## Phase 6 close + Phase 7 final acceptance (2026-07-27)

- **Phase 6** (complete): Agent M adversarial review delivered; RB-1/RB-2/RB-3 and HIGH wave closed in code + docs honesty (Java PostHog seam-only). Re-verify: [phase6-verification.md](phase6-verification.md) → CONDITIONAL GO; residuals (gofmt, Java `sendExposure` default, stale known-gaps) cleared before/at Phase 7.
- **Phase 7** (complete): Final acceptance report at [final-acceptance-report.md](final-acceptance-report.md). Verification re-run green:
  - `bash scripts/test-all.sh` → exit 0 (Node 89u+16i; Python 239; Go gofmt+vet+build+race OK / 75 PASS verbose; Java 89 surefire; 4 offline examples)
  - `bash scripts/conformance-all.sh` → exit 0 (65 fixtures; node 63+2sk / python 65 / go 65 / java 64+1sk; **0 undeclared divergences**)
  - `bash scripts/build-all.sh` → exit 0 (dry-run artifacts + SHA256SUMS; nothing published)
- **Go / no-go:** **GO for pre-release scaffolding** (CI, dry-run packaging, docs, tags-when-authorized). **NO-GO for public npm/PyPI/Maven publish** until company license/name ratification + registry provisioning (see `.github/RELEASE.md`). No packages published in Phase 7.

## Ruling 21 — Fireweave proxy backend (2026-07-27)

Production apps use **Fireweave credentials** only; SDK → **fw-server** → PostHog (or future vendor). Documented in ADR-0005. PostHogAdapter demoted to advanced/direct escape hatch. fw-server proxy routes do not exist yet — required before claiming the remote path in published packages.
