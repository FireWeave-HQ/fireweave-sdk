# Fireweave SDK v1 — remaining implementation

**Baseline:** commit `fbb120d` on `feat/control-points-v1`.
**Green:** node 88 pass / 1 fail · web 33 pass / 0 fail.
**The 1 fail is the work list**: `control-points-surface.test.ts` → *"releases must not be exposed in v1"*.

Scope is fixed by `spec/control-points.md`, `spec/modes.md` and ADR-0010. `docs/` and the
OpenFeature-forked `contracts/` are out of scope and are not edited by any phase below.

---

## Phase 1 — finish the node core

Everything else copies node, so node is the reference. Nothing in phases 2+ starts until
`control-points-surface.test.ts` is green.

### 1.1 Remove the five cut namespaces

`client.ts` is 578 lines and still defines `ReleasesApi`, `ExposuresApi`, `SignalsApi`,
`GuardrailsApi`, `CapabilitiesApi`.

**Why this is not a text cut** — two attempts failed this way already:
- `ReleasesApi` takes `SignalsApi` as a constructor argument, so ordering matters.
- `noteDeprecatedFlagsAlias`, `FireweaveClientOptions` and `SUPPORTED_CAPABILITIES` are
  interleaved *between* the class bodies. Cutting class-to-class removes them too.
- A rename to private fields is not a delete; it leaves dead code under confusing names.

**Do:** remove `guardrails` → `capabilities` → `exposures` → `releases` → `signals`, in that
order, keeping the interleaved helpers. Delete `TelemetryPolicy`, `ExtensionResult`,
`ReleaseResult`, `ExposureResult`, `SignalResult` from the barrel. Delete the tests that
cover only removed classes; keep any that also cover control points.

**Done when:** `control-points-surface.test.ts` passes all four tests.

### 1.2 `initFireweave(options)` with `mode`

The single entry point. `spec/modes.md` is normative.

- `mode: 'local' | 'remote'` — **required, never inferred.** A missing credential must not
  silently become local evaluation; that failure mode looks like a green boot and a feature
  that never ramps.
- `remote` requires `apiKey` + `apiUrl`; `local` takes `local.controlPoints`.
- Supplying credentials in `local` mode is a `Configuration` error, not a silent ignore.
- Init failures **throw**; reads never do.
- Returns a `FireweaveClient`. Selects the adapter and does nothing else conditional on mode.

### 1.3 Validation into `domain/`

Today validation sits in 7 files. Collect it as pure, total functions returning
`Validated<T> = { ok: true; value: T } | { ok: false; error: FireweaveError }`.

`validateControlPointKey` · `validateDefaultValue` · `validateContext` ·
`validateTargetingKey` · `validateInitOptions`.

Returning rather than throwing is what makes "degrade to the caller's default" a type instead
of a convention, and what ports to Go's `(T, error)` and Rust/Swift `Result`.

### 1.4 Relayer to `domain/` · `application/` · `infrastructure/`

`domain/` types · decision · context · target · errors · validation
`application/` ports · runtime · control-points · register-target · mode
`infrastructure/` adapters/{remote,local} · transport · hosts

Add guard tests: `dependencies: {}` stays empty, and `domain/` imports nothing from the
outer layers.

---

## Phase 2 — fix the test harness before propagating

**This blocks phase 3 and is not optional.**

Node tests import `@fireweaveai/sdk` — the package name — which resolves to `dist/`, not
`src/`. After three source files were deleted the suite still reported *115 pass / 0 fail*,
and `provider.test.ts` passed 7 tests against a file that no longer existed. `tsc` also does
not prune deleted sources, so a stale `dist/provider.js` survived a normal rebuild.

Every green in this repo is currently a claim about the last build, not the current source.

**Do:** add a `clean` step before `build`; point the test config at `src/` via a path alias,
or make `test` depend on a clean rebuild. Verify by deleting an export and confirming the
suite goes red without a manual `rm -rf dist`.

---

## Phase 3 — propagate to web, python, java, go

Same nine methods, same two modes, same layering. Per-language gaps found by audit:

| Language | Gap |
| --- | --- |
| web | four `*Details`; recording `registerTarget`; keep ADR-0009 sync reads — prefetch async, evaluation a pure cache read |
| python | `get_integer_value` → `get_number_value` (alias the old name, deprecated); **add the missing object variant**; four `*Details` |
| java | four `*Details`; recording `registerTarget` |
| go | **no `ControlPoints` namespace at all** — still `client.Flags()`; add it with `Flags` retained as the ADR-0007 alias; four `*Details`; recording `registerTarget` |

Run `conformance/surface/` against each. A language is done when its cell is green.

---

## Phase 4 — conformance runner

`contracts/harness.md` defines the pipeline as *"invoke `when` via real OF client"* and gives
every runner an OF-setup column. Rewrite to invoke `controlPoints`, in both modes. Fixtures
and `spec/` survive — `decision.schema.json` is Fireweave's own (`$id: fireweave.ai/spec/…`),
and only 1 of 76 fixture files names an OpenFeature package.

Prove on node, then propagate. Aggregate report goes from 65 × 4 cells to 65 × 7.

---

## Phase 5 — folder restructure and rename

Deliberately last: moving files while changing their contents makes the diff unreviewable.

- `sdks/node/packages/sdk/` → `sdks/node/`; same for web. Drop both private
  `*-workspace` wrappers and one of the two lockfiles each (`bun.lock` + `package-lock.json`).
- Go module path loses the `sdks/go` segment.
- Java parent artifactId `sdk` → a real name.
- **`@fireweaveai/sdk` → `@fireweaveai/server-sdk`.**

**Sequence the rename across repos:** publish `server-sdk` → update the **11 files** in
fireweaveai-platform that reference `@fireweaveai/sdk` (ts-server provider template,
`sdk-contract.guard.test.ts`, the install matrix in `initialise/SKILL.md`, the FIR-359
harness-report field) → *then* `npm deprecate` the old name. No window where the skill
scaffolds an install of a package that is not published yet.

---

## Phase 6 — rust, then swift

**Rust first.** It shares node's async shape and has no UI-lifecycle question, so it is the
honest test of whether the frozen spec is buildable from scratch by someone who did not write
it. Anything ambiguous surfaces here, cheaply.

**Swift follows web**, not node: a UI thread cannot await inside a render path, so ADR-0009's
prefetch-plus-sync-read is the pattern that already solves it.

Both: zero dependencies beyond an HTTP client and a JSON parser. That constraint is what
makes seven languages tractable and must not be relaxed for convenience.

---

## Phase 7 — release automation

`release.yml` already has `workflow_dispatch` with component/version/channel/dry_run, npm OIDC
trusted publishing, and an `environment: release` gate. Four changes:

1. `version` free-text → **`bump: patch|minor|major`**, computed from the manifest.
2. Components → add web, rust, swift; rename node → server. Add `all` (matrix fan-out).
3. Staging identity: npm dist-tag → **version suffix** `1.4.0-staging.3`. A dist-tag is a
   pointer — the same bytes can be staging today and production tomorrow, and the installed
   artifact records nothing. A suffix puts the channel in the version, and matches `fw`'s
   existing rule (prerelease segment ⇒ staging).
4. New `tools/release/version.sh`: read → bump → write, per ecosystem.
   - **Strip any prerelease before bumping** — `1.4.0-staging.3` + patch must give `1.4.1`,
     or a staging line can never graduate.
   - **Count staging iterations from the registry, not a local file** — two people releasing
     from different branches would both compute `-staging.1`.

**Add a `verify` job** between resolve and publish (build + test + conformance). Today a
release can publish without running the gates.

### Secrets

| Name | Environment | For | State |
| --- | --- | --- | --- |
| `PYPI_API_TOKEN` | `release` | python prod | exists |
| `TEST_PYPI_API_TOKEN` | `release-staging` | python staging | **add** |
| `MAVEN_CENTRAL_USERNAME` / `_PASSWORD` | `release` | java | exists |
| `MAVEN_GPG_PRIVATE_KEY` / `_PASSPHRASE` | `release` | java signing | exists |
| `CARGO_REGISTRY_TOKEN` | `release` | rust | **add** |
| npm | — | server · web | OIDC, no secret |
| go · swift | — | tag push | built-in `GITHUB_TOKEN` |

**Two environments, not one.** Production tokens must be unreachable from a staging run, so a
workflow bug cannot publish to PyPI when the operator believed they were hitting TestPyPI.
Keep the reviewer requirement on `release` only.

**No staging registry exists for rust or swift.** crates.io has no TestPyPI equivalent and
yanking is not deletion — a staging prerelease spends the version permanently. Stop rust
staging at `cargo publish --dry-run` plus the git tag. Go and Swift resolve from git tags, so
their staging release *is* a tag.

---

## Open

None. Both prior questions are settled:

- **`java/fireweave-testing`** — removed. The java build is now a single `fireweave-sdk`
  module; `fireweave-openfeature` and `fireweave-adapter-posthog` went with ADR-0010.
- **Local-mode target registration** — records in-process and traces the call. Implemented in
  node (`FireweaveLocalAdapter.registerTarget`); phase 3 propagates it to web, python, java
  and go, and phase 6 to rust and swift. `spec/modes.md` is normative.
