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
| E — Contract & conformance lead | Fixtures, error taxonomy, conformance harness | `contracts/`, `test-server/` | `design/contracts` | A, B, C (parallel w/ D) | Canonical fixtures, error taxonomy, harness spec | **in progress** | 3 |
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
