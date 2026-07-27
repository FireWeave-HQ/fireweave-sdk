# Repository Assessment — Fireweave Existing Codebases

Agent A (Repository archaeologist) — research output, Phase 1.
Date: 2026-07-27. All paths verified on disk; no repository other than this file was modified.

---

## 1. Repository map

### 1.1 `/Users/niketh/Coding/Fireweave/FireWeave` — main platform monorepo (PRIMARY)

- **Git**: `git@github.com:FireWeave-HQ/FireWeave.git` (GitHub org **FireWeave-HQ**). Active — commits through late July 2026.
- **Purpose**: The FireWeave platform — safe-rollout / release-safety product. Contains the API server, webapp, marketing website, integrations, the existing TypeScript deploy SDK, the rollout MCP server, CLI, and plugins.
- **Languages**: TypeScript only (plus bash for infra scripts). No Python, Go, Rust, or Java source anywhere in the workspace (verified: no `*.py`, no `go.mod` outside `node_modules`).
- **Package manager / build**: **Bun** (`"packageManager": "bun@1.3.4"`), Bun workspaces + `turbo.json`. Workspaces: `apps/*`, `libs/*`, `packages/*`, and `packages/fw-plugins/src/plugins/fireweave/mcp/*`.
- **Test framework**: `bun test` (Bun's built-in runner; `*.test.ts` colocated with source). Root scripts: `bun run typecheck`, `bun run lint`, `bun test packages/`, per-tier `test:unit` / `test:integration` / `test:contract` / `test:e2e` / `test:acceptance` / `test:regression` (filtered to `@fireweaveai/integration-*`).
- **CI**: GitHub Actions in `.github/workflows/` (22 workflows) on **self-hosted Linux runners** (ADR-011/017: runners on EKS). `ci.yml` jobs: `test-packages` (`bun test packages/`), `typecheck`, `validate-structure`, `wiki-lint`, `arch-check`, `platform-reconcile-check`, `capability-schemas-additive`, etc. Publishing workflows: `publish-deploy-sdk.yml`, `publish-fw-cli.yml`, `publish-plugins.yml`; deploys via `deploy-staging.yml`, `promote-to-prod.yml`, `deploy-box.yml`.
- **Versioning / release conventions**:
  - Deploy tags: `prod_YYYY.MM.DD-N` and `staging_YYYY.MM.DD.N` (calendar-based deploy tags, not semver).
  - Package publishes: `<component>/v<semver>` tag convention shared by `publish-fw-cli.yml` and `publish-plugins.yml`; a stable vs. **staging dogfood channel** is resolved from the tag (`tools/publish/lib/channel.ts`). The deploy-sdk publishes to **public npmjs.org via OIDC trusted publishing** (no NPM_TOKEN), `access: public`, dist-tags `latest` and `staging`.
- **Licensing**: **No repo-level LICENSE file** — the monorepo is private/proprietary. The one package with an explicit license, `packages/deploy-sdk/LICENSE`, is a **FireWeave proprietary license** ("Copyright (c) 2026 FireWeave. All rights reserved… may not copy, modify, … redistribute"). `package.json` says `"license": "SEE LICENSE IN LICENSE"`.
- **Contribution policy / governance**: No CONTRIBUTING.md, no CODEOWNERS, no CLA, no DCO, no CODE_OF_CONDUCT anywhere in FireWeave-authored repos. Internal conventions live in `CLAUDE.md`, `AGENTS.md`-style docs, `docs/adr/` (MADR format, numbered `NNN-title.md`), and `docs/wiki/`.
- **Code-ownership conventions**: feature-sliced DDD layout in `apps/fw-server/src/features/<feature>/{domain,application,infrastructure}`; packages own vertical concerns; ADRs are the decision log.

### 1.2 `/Users/niketh/Coding/fireweave-data-engine`

- **Git**: `git@github.com:FireWeave-HQ/fireweave-data-engine.git`.
- **Purpose**: A **fork of OpenObserve** (Rust observability engine), `Cargo.toml` name is still `openobserve`, version 0.60.0. Serves as FireWeave's telemetry/data backend.
- **Languages/build**: Rust (Cargo, `rust-toolchain.toml`, clippy/rustfmt/deny configs) + Vue.js web UI (`web/`). Build: `cargo build`; tests: `cargo test` + `coverage.sh`.
- **License**: **AGPL-3.0** (upstream OpenObserve license, unchanged). `CONTRIBUTING.md` and `SECURITY.md` are upstream OpenObserve's, not FireWeave's.
- **SDK relevance**: none directly, but a hard rule follows: **do not vendor or copy any code from this repo into the SDK** — AGPL-3.0 is incompatible with a permissively licensed SDK.

### 1.3 `/Users/niketh/Coding/Fireweave-gitops`

- Misleading name: it is a **Next.js 16 sample/marketing app** (`"name": "fireweave-app"`) configured for Dokploy deployment. React 19, Tailwind 4, ESLint 9. Build: `npm run build`. No flags/PostHog/OpenFeature content (verified by grep). Not relevant to the SDK. (A newer `/Users/niketh/Coding/fireweave-gitops-v2` exists with actual cluster/gitops Makefile content; also not SDK-relevant.)

### 1.4 `/Users/niketh/Coding/fireweave-dataplane-gitops`

- **Pulumi (TypeScript)** IaC for a minimal EKS cluster on AWS (`@pulumi/eks`, `Pulumi.yaml`, `cluster.yaml`). Commands: `pulumi preview` / `pulumi up`. No SDK-relevant code.

### 1.5 `/Users/niketh/Coding/Fireweave-slackbot`

- Small TypeScript Slack bot (`@slack/bolt`) for observability/incident management. `tsc` build, no test framework configured, license field "ISC" (boilerplate; no LICENSE file). Not SDK-relevant. Has a local untracked `.env` on disk (not committed — verified via `git ls-files`).

### 1.6 `/Users/niketh/Coding/FireTunnel`

- **Empty directory.** No files, no git history. Nothing to assess.

### 1.7 `/Users/niketh/Coding/fireweave-bkup`

- A **stale copy of the main monorepo** (last commit 2026-07-10, vs. the live repo's late-July commits). Same `fireweaveai-platform` package.json. One structural difference: the rollout MCP server still lives at the old path `mcp/rollout-server/` (it has since moved to `packages/fw-plugins/src/plugins/fireweave/mcp/rollout-server` in the live repo). Deprioritized as instructed; use the live repo as source of truth.

### 1.8 Adjacent repos noticed (not in scope, but relevant to conventions)

- `/Users/niketh/Coding/terraform-provider-fireweave` — **Go**: `module github.com/FireWeave-HQ/terraform-provider-fireweave`, `go 1.25.8`, terraform-plugin-framework. Establishes the org's Go module-path convention: `github.com/FireWeave-HQ/<repo>`.
- `/Users/niketh/Coding/fireweave-mcp` — separate small "fireweave-api-docs-mcp" server (npm-installed MCP SDK). Not the rollout server.

---

## 2. Relevant existing modules (paths + summaries)

All paths below are relative to `/Users/niketh/Coding/Fireweave/FireWeave`.

### 2.1 `packages/deploy-sdk` — `@fireweaveai/deploy-sdk` v0.1.0 (THE key prior art)

An existing TypeScript-only SDK that is, conceptually, v0 of what the new polyglot SDK generalizes: "Boot-time deploy attestation + feature-flag runtime… zero-runtime-dep core, with optional OpenFeature + OpenTelemetry integration behind subpath entries."

- Entry points (from README/`exports`):
  - `.` — zero-dependency attestation core (`initFwAttestation`).
  - `./attest` — boot-beacon env wiring + fetch transport (`FW_ATTEST_URL`, `FW_PROJECT_API_KEY`).
  - `./flags` — OpenFeature + OTel server flag runtime.
  - `./flags/web` — browser flag facade.
  - `./eject` — codemod (ts-morph AST) that removes FireWeave wiring, leaving raw OpenFeature.
  - `./profile` — capability/surface-support matrix.
- Key source:
  - `src/flags/providers/posthog.provider.ts` / `posthog.web.provider.ts` — **FireWeave-authored thin OpenFeature providers over official `posthog-node` / `posthog-js`**.
  - `src/flags/providers/fireweave-local.provider.ts` (+ `.web`) — in-memory dev provider with `devFlags` + `FW_DUMP` echo.
  - `src/flags/otel/{init,hooks.server,hooks.web}.ts` — OTel flag-evaluation hooks (uses `@openfeature/open-telemetry-hooks`).
  - `src/flags/anchor/detect-anchor.ts` — `@fireweave-flag` code-anchor scanning.
  - `src/core/{beacon,attestation,dedup,backoff,ports}.ts` — deploy **boot beacon**: payload of `stampId` strings (liveness signal), surface entries keyed by `sfc_<ULID>` surface IDs; wire contract mirrored (not imported) from `@fireweaveai/contracts` so the core stays zod-free.
  - `src/flags/test-harness.ts` — flag test harness.
- Dependencies: `@openfeature/core` ^1.11, `@openfeature/server-sdk` ^1.22, `@openfeature/web-sdk` ^1.9, `@openfeature/open-telemetry-hooks` ^1.0, full OTel SDK set, `posthog-js` ^1.395, `posthog-node` ^5.38, `ts-morph`.
- Published publicly to npm under `@fireweaveai/deploy-sdk` with **stable and `staging` channels**; the default fw-server ("attest") URL is baked per published channel.
- **License: proprietary** (see §1.1) — despite being on public npm.

### 2.2 `packages/fw-plugins/src/plugins/fireweave/mcp/rollout-server` — `@fireweaveai/rollout-server`

Source of the "fireweave-rollout-server" MCP plugin (the tool names match the live plugin: `detect_baseline`, `recommend_rollout_strategy`, `generate_wrapper`, `verify_cohort_keying`, `verify_no_orphan_flags`, `verify_safe_defaults`, `verify_no_mixed_provider_calls`, `verify_telemetry_completeness`, `verify_rollout_config_schema`, `verify_provider_health`, `verify_prod_path`, `detect_rollout_ready`, `reconcile`, `eject`, `find_cleanup_candidates`, `build_register_rollout_from_manifest`, `provision_deploy_beacon_env`, `assert_dev_checklist`, `read/write/clear_lockfile`, `read/write_confirmation_receipt(s)`, `guarded_call`, `tag_baseline_commit`, `select_project`, `ensure_auth`, `read/write_preferences`, `propose_metrics`, `analyze_codebase`, `extract_diff_surface`, …). One `.ts` file per tool under `src/tools/`, all with colocated tests. Depends on `@fireweaveai/{contracts,deploy-sdk,diff-surface}` + `simple-git` + MCP SDK.

**Data model implied (the SDK's release/rollout extension APIs must align with this):**

- **Rollout-ready manifest** (committed at `.fireweave/rollout-ready/<feature>.json`, schema v1/v2 — see live examples in the repo root's `.fireweave/rollout-ready/`): declares `feature`, `changeType`, a `change` block (`chg_`/`stmp_` ULID IDs, branch, author, status), `flags[]` (key, **safe `default`**, **`cohortKey`** e.g. `orgId`, tags), `wrapPoints[]` (file + symbol + `wrapStyle: function-guard` + flagKey), `context` (`targetingKey` + dimensions), `telemetry` (metrics with `role: adoption`, `direction: up-good/up-bad`, guards), and a `harness` block (surface `ts-server`, `flags.api: "openfeature"`, `rolloutProvider: "connected:posthog"`, `rolloutCredentialEnv: POSTHOG_PROJECT_API_KEY`, attest env vars, `telemetry.api: "otel"`, semconv `fireweave/rollout-otel-semconv-v1`).
- **Committed config (v2 split-file model)**: `.fireweave/project.json` + `.fireweave/rollouts/<rolloutId>.json`, owned by `read/write_preferences`.
- **Lockfile** (`.fireweave/.cache/.lockfile`, gitignored, atomic tmp+rename writes): skill-resume state machine `discovery → codegen → summary → created → finalize` (legacy `register`), tracks `diffApplied`, `rolloutId`, `participantId`; force-push detection against the participant; cleared on successful register (`src/tools/lockfile.ts`).
- **Confirmation receipts**: persisted human-confirmation records consumed by `_receipt-guard.ts` / `guarded_call` so destructive or irreversible tool calls require a prior receipt (question-hash keyed, `src/tools/question-hash.ts`).
- **Baselines**: `detect_baseline` / `tag_baseline_commit` — a rollout is measured against a tagged baseline commit.
- **Deploy beacon**: `provision_deploy_beacon_env` wires `FW_ATTEST_URL` / `FW_PROJECT_API_KEY`; the SDK-side beacon (§2.1 core) posts stamp liveness on boot; the server matches `stampId` → registered `change_stamps` row.
- **Cohort keying**: `verify_cohort_keying` enforces that flag evaluation uses a stable cohort key (OpenFeature `targetingKey`, e.g. `orgId`) so ramp percentages are sticky per cohort.
- **Draft-first registration** (ADR-016): `register_rollout` creates a draft (commitSha null) → `update_rollout_spec` → `finalize_rollout`.

### 2.3 `packages/contracts` — `@fireweaveai/contracts` (private)

Zod schema source of truth. `src/rollout/` contains: `rollout-ready-manifest.zod.ts`, `rollout-config.zod.ts` + `rollout-config-v2.zod.ts`, `rollout-persisted-spec.zod.ts`, `wrap-point.zod.ts`, `guardrail.zod.ts`, `metric-observation.zod.ts`, `verification.zod.ts`, `change-stamp.zod.ts`, `lockfile.zod.ts`, `manifest-surfaces.ts`, `capability-id.zod.ts`, `intelligence-snapshot.zod.ts`, beacon schemas, plus `src/rollout/http/`. Also `src/integration/capabilities/feature-flags/` — vendor-neutral integration capability contracts: `flag.create.v1`, `flag.evaluate.v1`, `flag.control.v1`, `flag.delete.v1`, `projects.list.v1`. **This package is private (not published)** — the new SDK cannot import it; schemas would need to be published, mirrored, or re-specified (the deploy-sdk already deliberately mirrors rather than imports them).

### 2.4 `packages/integration-posthog` — `@fireweaveai/integration-posthog` v0.4.0 (private)

Server-side integration service (runs as a container next to fw-server; NATS transport, awilix DI) implementing the feature-flag capability contracts against the **PostHog REST API** (flag CRUD/control for ramping), plus OAuth onboarding (ADR-015 `posthog-user-onboarded-oauth`). This is the *control-plane* side of PostHog (create/ramp flags); the deploy-sdk providers are the *data-plane* side (evaluate flags). Sibling integrations: `integration-github`, `integration-linear`, `integration-openobserve`, `integration-sentry`, `integration-slack`, all built on `packages/integration-sdk` (`@fireweaveai/integration-sdk`, the internal integration-runtime framework — not a customer SDK).

### 2.5 `apps/fw-server/src/features/rollouts`

Rollout engine: DDD slices (`domain/ramp`, `domain/entities`, `application/use-cases`, `infrastructure/{restate,nats,http,persistence,alerts,observability,playbooks}`). Ramp loops are **Restate**-based durable workflows (`signal-driven-ramp-loop.ts`, `replay-safe-ramp-control.ts`). Server-side only; the SDK talks to it via the attest/beacon HTTP contract and via PostHog for flag evaluation.

### 2.6 App harness wiring (reference integrations of the existing SDK)

- `apps/fw-server/src/fireweave/fw-providers.ts` — scaffolded by `/fireweave:initialise`; `makeConnectedVendorProvider()` binds the PostHog OpenFeature server provider from `POSTHOG_PROJECT_API_KEY`/`POSTHOG_HOST`; `makeDevProvider()` binds `FireweaveLocalProvider` with committed `devFlags`. `fw eject` deletes the file.
- `apps/fw-website/src/lib/fireweave/{fw-providers,fw-harness}.ts` and `apps/fw-webapp/src/lib/fireweave/fw-providers.ts` — web-surface equivalents (browser facade).
- Guard-file convention: `<feature>.guard.ts` exporting a function guard per flag (e.g. `apps/fw-server/src/features/org-api-keys/application/org-api-keys-v1-management.guard.ts`).

### 2.7 ADRs directly governing the new SDK's design space (`docs/adr/`)

- **ADR-017 `017-language-native-flag-provider-strategy.md`** (Proposed, 2026-07-09) — the single most relevant document. Decision: *"FireWeave authors and owns a thin OpenFeature provider per language, wrapping the official vendor SDK"* (PostHog v1), mapping OpenFeature `targetingKey` → PostHog `distinct_id` and context dimensions → person/group properties. Community providers rejected as prod dependencies (Python's `posthog-openfeature-provider-python` 0.1.1: unmaintained/unlicensed; Go's `dhaus67/openfeature-posthog-go`: adopt only if a review passes). Plans named `packages/deploy-sdk-py` for Python; Rust falls back to a "beacon-only" tier. Requires every provider to pass a **conformance suite mirroring `posthog.provider.test.ts`**. **Note: covers Python/Go/Rust — Java is absent.**
- **ADR-002 `002-open-source-only-mandate.md`** (Accepted, 2026-05-15) — org-wide mandate: tools/deps must be OSI-licensed or FSL/BSL-style source-available with auto-conversion to OSI. Governs what the SDK may depend on. (It governs *consumption*, not the license FireWeave *ships* under — the deploy-sdk ships proprietary.)
- **ADR-016** draft-first rollouts + config v2; **ADR-013/014** CLI surface conventions; **ADR-011/017(dup number)** self-hosted runners / GHA on EKS.
- Also relevant docs: `docs/user-journey-safe-rollout.md`, `docs/runbook-deploy-sdk-publish.md`, `docs/runbook-fw-server-deploy-ramps.md`, and the skill `packages/fw-plugins/src/plugins/fireweave/skills/safe-rollout-fast/SKILL.md`.

### 2.8 `packages/deploy-sdk/src/profile/surface-support.ts` — surface registry

`HarnessSurface = 'ts-server' | 'web' | 'go' | 'rust' | 'python' | 'dart'`. `SURFACE_REGISTRY` marks **only `ts-server` (and web) as prod-provider-capable (`POSTHOG_ONLY`)**; go/rust/python have `NO_PROD_VENDORS`. `verify_prod_path` skips surfaces without prod vendors. **There is no `java` surface** — adding Java means extending this enum and the manifest surface schema (`packages/contracts/src/rollout/manifest-surfaces.ts`, schema-2 `surfaces[]`).

### 2.9 Other flag/telemetry-adjacent packages

- `packages/diff-surface` (`@fireweaveai/diff-surface`, private) — diff-surface extraction used by `extract_diff_surface`.
- `packages/fw-cli` (`@fireweaveai/fw-cli`, bin `fw`) — compiled Bun binaries per-platform (`fw-linux-x64`, `fw-darwin-arm64`, …); "deterministic preflight + auth surface for the rollout skill"; `fw eject` lives here conceptually.
- `libs/event-pipeline`, `libs/common-utils` — internal shared libs (Bun/TS only; not reusable cross-language).

---

## 3. Existing public API constraints and naming/package-scope conventions

| Ecosystem | Existing usage | Constraint for new SDK |
|---|---|---|
| GitHub | Org **`FireWeave-HQ`**; repos `FireWeave`, `fireweave-data-engine`, `terraform-provider-fireweave` | New repo naming `fireweave-sdk` fits the org's kebab-case convention. |
| npm | Scope **`@fireweaveai`** is registered and actively published to public npmjs.org (`@fireweaveai/deploy-sdk`, plus `fw-cli`/plugins via the marketplace flow) with **OIDC trusted publishing** and a `staging` dist-tag channel | New Node package must live under `@fireweaveai/*`. Avoid colliding/confusing with `deploy-sdk`; e.g. `@fireweaveai/sdk` or `@fireweaveai/openfeature-provider-*`. Trusted-publisher config must be added per new package. |
| PyPI | **No existing FireWeave packages found**; ADR-017 reserves the in-repo name `packages/deploy-sdk-py` but nothing is published | `fireweave` / `fireweave-sdk` PyPI names are unverified — availability must be checked and registered early (risk §6). |
| Go | `github.com/FireWeave-HQ/terraform-provider-fireweave` | Go module path should be `github.com/FireWeave-HQ/fireweave-sdk/...` — which **requires the SDK to live in its own public repo** (or use vanity imports). |
| Maven | **No existing Java/Maven usage anywhere** | GroupId unclaimed; `ai.fireweave` (matching the `fireweave.ai` domain) is the natural choice; requires Sonatype/Central namespace verification (risk §6). |
| Env vars | `FW_ATTEST_URL`, `FW_PROJECT_API_KEY`, `FW_DUMP`, `POSTHOG_PROJECT_API_KEY`, `POSTHOG_HOST` | Reuse the same names for drop-in compatibility with existing harnesses and `provision_deploy_beacon_env`. |
| API concepts | OpenFeature everywhere (`targetingKey` = cohort key, e.g. `orgId`); wrap points as `*.guard.ts` function guards; `@fireweave-flag` code anchors; beacon `stampId` (`stmp_<ULID>`), `sfc_<ULID>` surface IDs; OTel semconv `fireweave/rollout-otel-semconv-v1` | The polyglot SDK's flag facade must remain OpenFeature-shaped and its rollout extensions must speak these identifiers to stay compatible with rollout-server verification tools. |
| ID format | Crockford ULID with typed prefixes: `chg_`, `stmp_`, `sfc_`, `rolloutId` | Adopt the same typed-ULID convention in SDK contracts. |
| Versioning | Packages: semver with `<component>/v<semver>` tags + stable/staging channels; deploys: calendar tags | Adopt `<component>/v<semver>` tag-triggered publishes for consistency. |

---

## 4. Recommended location & packaging strategy

**Recommendation: polyglot monorepo in the new standalone repo (`FireWeave-HQ/fireweave-sdk`), one directory per language (`sdks/node`, `sdks/python`, `sdks/go`, `sdks/java`), publishing per-ecosystem artifacts from a shared CI.** This matches the orchestration ledger's planned layout.

Why not inside the main `FireWeave` monorepo:

1. **License wall.** The main repo is private and its SDK package is proprietary-licensed. An open-source SDK inside it would be either unpublishable-as-OSS or would force open-sourcing surrounding code. A separate repo gives a clean licensing boundary.
2. **Go requires it.** A public Go module path (`github.com/FireWeave-HQ/fireweave-sdk`) needs a public repo root; carving a public module out of a private monorepo doesn't work without proxy/vanity-import machinery.
3. **Toolchain mismatch.** The main repo is Bun-only (bun workspaces, `bun test`, Bun-compiled binaries, self-hosted runners). Python/Go/Java toolchains bolted into it would fight `turbo.json`, `validate:tsconfig`, `arch-check`, and the workspace-glob assumptions.
4. **Open-source hygiene.** Public issues/PRs, CLA/DCO checks, community docs, and conformance CI matrices should not run on the company's self-hosted EKS runners against a repo containing prod deploy workflows and vault seeding (`seed-creds.yml`, `unseal-platform-vault.yml`).

Why not per-language repos (yet):

1. The contract/conformance layer (Agent E's fixtures, error taxonomy, schemas) is the product; keeping all four SDKs against one canonical fixture set in one repo prevents drift — exactly the failure mode ADR-017's conformance-suite requirement is designed to catch.
2. Four repos quadruple release/CI/governance surface before there is any community. Split later if per-language communities emerge (the per-language directories keep that door open; Go's module path just gains a `/go` or stays subdirectory-rooted via a `go.mod` in `sdks/go` published as `github.com/FireWeave-HQ/fireweave-sdk/sdks/go` — or promote to `fireweave-sdk-go` at that point).

Packaging targets: npm `@fireweaveai/*` (OIDC trusted publishing, mirroring `publish-deploy-sdk.yml`'s pattern), PyPI (name TBD/register), Go module (repo path), Maven Central under a to-be-verified `ai.fireweave` groupId.

**Relationship to `@fireweaveai/deploy-sdk`:** treat it as prior art and the compatibility target, not a code source (proprietary license; also Bun/TS-idiomatic). The new SDK should implement the same *wire contracts* (beacon payload, manifest/harness expectations, env vars) from specification, cleanly rewritten under the new license. Long-term, deploy-sdk's TS provider could be re-based on the open SDK — that's a company decision outside this effort.

## 5. Recommended ownership boundaries

- **Canonical contracts/fixtures** (`contracts/`, `spec/`): single owner (Agent E per ledger); language agents consume, never edit. This mirrors how `@fireweaveai/contracts` is the schema source of truth internally and how deploy-sdk *mirrors* (never imports) beacon schemas with explicit parity notes — keep that discipline: every mirrored schema carries a parity comment pointing at the canonical file.
- **Per-language SDKs** (`sdks/<lang>/`): one owner each; no cross-language file sharing; identical conformance suite (ADR-017 requirement) as the coupling mechanism instead of shared code.
- **Rollout/attest extension APIs**: align with rollout-server tool expectations (manifest harness block, beacon, env provisioning); changes to those shapes must be coordinated with the main-repo team that owns `packages/contracts/src/rollout/` — the SDK repo should not unilaterally evolve them.
- **CI/release** (`.github/`, `scripts/`): infra owner (Agent K), using hosted runners (not the company's self-hosted EKS fleet) since this is a public repo.
- **Surface registry parity**: adding `java` (and formally `node-server` vs `ts-server`) to `HarnessSurface`/`SURFACE_REGISTRY`/`manifest-surfaces` lives in the main repo — file as an upstream request, don't fork the enum.

## 6. Risks and blockers

1. **License decision is unmade and conflicts with precedent (BLOCKER).** The company's only published SDK is proprietary-licensed on public npm; the main repo has no LICENSE; ADR-002 governs inbound deps but not outbound licensing. Shipping this SDK as OSS (MIT/Apache-2.0 expected for OpenFeature ecosystem) needs an explicit company decision, and no code may be copied from `deploy-sdk` until then.
2. **Duplication/divergence with the internal multi-language effort.** ADR-017 and branch `feat/multi-language-rollout-support` already plan `deploy-sdk-py`, Go, and Rust providers *inside the main repo*. Two parallel SDK efforts risk conflicting packages under the same npm scope/PyPI names and diverging provider behavior. Needs an explicit "the new repo supersedes ADR-017's in-repo language packs" (or vice-versa) decision.
3. **Java has no footprint anywhere.** No `java` surface in `SURFACE_REGISTRY`/manifest schema, no Maven groupId, no JVM code in the org, and ADR-017 doesn't cover it — Java support requires upstream schema changes in the main repo plus Maven Central namespace verification (slow, DNS-based) before any release.
4. **Registry namespace gaps**: PyPI names unregistered/unverified; Maven groupId unclaimed; npm trusted-publisher entries must be provisioned per new package by whoever owns the `@fireweaveai` npm org.
5. **Private contracts package.** `@fireweaveai/contracts` (rollout schemas, beacon wire contract) is unpublished; the SDK must re-specify these shapes and then hold parity by convention — a silent-drift risk unless a published schema artifact or shared JSON-Schema export is negotiated.
6. **AGPL adjacency**: `fireweave-data-engine` is AGPL-3.0; any code reuse from it into the SDK is prohibited.
7. **No OSS governance scaffolding exists** anywhere in the org: no CLA, no DCO, no CONTRIBUTING, no CODEOWNERS, no code of conduct. All must be created from scratch (and the CLA-vs-DCO choice is itself an open decision).
8. **Secrets hygiene**: nothing sensitive found committed in the researched repos (only `.example` seeds; the slackbot's `.env` exists on disk but is untracked). Standard caution: never copy `.fireweave/` runtime config or `infra/.env.local` patterns into public examples with real keys.

## 7. Browser/mobile SDK reuse

- **Browser**: yes, prior art exists but is not reusable as code. `@fireweaveai/deploy-sdk/flags/web` (`src/flags/facade.web.ts`, `posthog.web.provider.ts`, `fireweave-local.web.provider.ts`, `otel/hooks.web.ts`) is a working browser facade over `@openfeature/web-sdk` + `posthog-js`, consumed by `apps/fw-website` and `apps/fw-webapp` (`src/lib/fireweave/`). It is proprietary-licensed and TS-only — usable as a **design reference** for a future web package, nothing more. The new SDK is server-side-first; no browser work needed now.
- **Mobile**: **none.** No React Native, iOS, Android, or Dart/Flutter code exists in any repo (the `'dart'` surface in `SURFACE_REGISTRY` is a declared enum value with `NO_PROD_VENDORS` and no implementation behind it).

---

*End of assessment. Written by Agent A; no other files modified, no commits made.*
