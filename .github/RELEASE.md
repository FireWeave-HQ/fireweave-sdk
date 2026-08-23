# Fireweave SDK — Release Process

Owner: release engineering (Agent K scope: `.github/`, `scripts/`, `tools/`).

Status (2026-07-27): **staging publish authorized** for npm
(`@fireweaveai/server-sdk`, dist-tag `next`), TestPyPI (`fireweave`), and Go
proxy warm — only when `workflow_dispatch` has `dry_run=false` and
`channel=staging`.

Status (2026-08-21, during the task-14 implementation work — **not** a
separate human authorization; flagged for a human to confirm rather than
inherit the 2026-07-27 sign-off by association): staging publish SCOPE
EXTENDED to also cover npm for `@fireweaveai/web-sdk` (dist-tag `next` —
identical OIDC trusted-publish mechanism as the already-authorized
`server-sdk`) and a rust `cargo publish --dry-run` (packages + validates
only; no crates.io upload — see "Pre-release channels"), under the same
`dry_run=false` / `channel=staging` gate.

**Production PyPI** is enabled for `fireweave` via:

- tag push `python/v<semver>` → [`.github/workflows/publish-python.yml`](workflows/publish-python.yml)
- or `release.yml` with `component=python`, `channel=production`, `dry_run=false`

**Production npm** (`latest`, both packages) remains hard-disabled
(`if: false`) until a second written authorization. **Maven Central** is
wired through [`publish-java.yml`](workflows/publish-java.yml) (tag
`java/v*`) and `release.yml` (`component=java`) using the Central Publisher
Portal plugin. The first upload still requires namespace verification for
`ai.fireweave` plus `MAVEN_CENTRAL_USERNAME` / `MAVEN_CENTRAL_PASSWORD` /
`MAVEN_GPG_*` secrets — missing secrets fail closed rather than publishing a
broken artifact. **crates.io** production publish requires
`CARGO_REGISTRY_TOKEN` — same fail-closed behavior.

## Overview

One release = one component (`server` | `web` | `python` | `java` | `go` |
`rust` | `swift`, or `all` to fan out every component via a matrix) at one
computed semver. Trigger [`Release (dry-run by default)`](workflows/release.yml)
via `workflow_dispatch`:

**`all` is not only a build-time convenience — with `dry_run=false` and
`channel=staging` it fires every staging publish job at once, unattended**
(both npm packages, TestPyPI, and the rust `cargo --dry-run`): `release-staging`
carries no required-reviewer gate, so selecting `all` there is the same as
approving all of them in one click, not just requesting seven builds.

| Input | Meaning |
| --- | --- |
| `component` | Which SDK to release (`all` fans out via matrix) |
| `bump` | `patch` \| `minor` \| `major` — applied to the component's OWN current manifest version by `tools/release/version.sh` (any existing prerelease is stripped first; there is no free-text `version` input) |
| `channel` | `staging` (default) or `production` — see pre-release channels |
| `dry_run` | `true` (default): build/changelog/SBOM/checksums only, no tag, no attestation, no publish |

The workflow always produces (as a CI artifact, never a registry upload):

- package artifacts (`npm pack` tarball, sdist+wheel, jars; Go and Swift ship
  via tags only — see "Tag convention"),
- `CHANGELOG-<component>-v<version>.md` generated from **conventional commits**
  (`tools/release/changelog.sh`, grouped feat/fix/perf/docs/breaking/other,
  scoped to the component's paths + shared `contracts/` + `spec/`),
- SPDX SBOM via syft (`anchore/sbom-action`),
- `SHA256SUMS` over every artifact,
- build provenance attestation (`actions/attest-build-provenance`, skipped in
  dry runs — requires repo attestation setting).

Between `build` and every `publish-*` job sits **`verify`**: the full
`scripts/{build,test,conformance}-all.sh` suite (every language, the same
65×7 cross-language differential gate CI runs) — a release cannot publish
without these gates passing, dry run or not.

## Versioning: `tools/release/version.sh`

`tools/release/version.sh` is the single source of truth for "what version
does this release actually carry." Two subcommands:

- `version.sh compute <component> <bump> <channel>` — reads the component's
  current version (from its manifest, or, for go/swift — which carry no
  version field — the highest existing plain `<prefix>/vX.Y.Z` tag,
  defaulting to `0.0.0` when none exists), strips any existing prerelease,
  applies `<bump>`, and (channel=staging only) appends `-staging.N` where `N`
  is queried live from the component's registry (npm / PyPI or TestPyPI /
  crates.io / `git ls-remote` against `origin` for go, java, and swift — see
  the script's own header for why those three use the tag list). Prints
  `key=value` lines; never writes anything.
- `version.sh apply <component> <release-version>` — writes an
  ALREADY-COMPUTED version into the component's manifest (no bump math, no
  network). go/swift are a documented no-op — the git tag already pushed by
  `build` is the version record.

`build` calls `compute` once per selected component and uploads the result
as a small `release-info-<component>` artifact; every `publish-*` job
downloads that artifact and calls `apply` with the same value, rather than
recomputing — see the workflow's own header comment for why recomputing
inside a publish job is unsafe for go/java/swift specifically (their
"registry" is the git tag list, which `build` has, by that point, already
changed by pushing the new tag).

Local, offline: `bash tools/release/version.test.sh` (pure semver logic —
strip-prerelease, bump, staging-N extraction — plus one end-to-end `compute`
run with the registry query stubbed out; zero network calls).

## Tag convention

Org convention `<component>/v<semver>`, with one forced exception:

| Component | Tag | Why |
| --- | --- | --- |
| server | `server/v0.1.0` | org convention (renamed from `node` — package is `@fireweaveai/server-sdk`; directory stays `sdks/node`; this component has never published, so the rename breaks no historical tag) |
| web | `web/v0.1.0` | org convention |
| python | `python/v0.1.0` | org convention |
| java | `java/v0.1.0` | org convention |
| rust | `rust/v0.1.0` | org convention |
| swift | `swift/v0.1.0` | org convention — chosen deliberately over a bare `vX.Y.Z`; see below |
| go | `sdks/go/v0.1.0` | **Go toolchain requirement**: a module in subdirectory `sdks/go` is only resolvable when the tag prefix equals the subdirectory path. `go/v0.1.0` would not resolve. |

**Why swift uses `swift/v<semver>` and not a bare `vX.Y.Z`:** SwiftPM's git
dependency resolution (`.package(url:, from:)`) requires `Package.swift` at
the ROOT of the referenced repository — there is no first-party "subdirectory"
parameter the way Go modules have one. This repo's `Package.swift` lives at
`sdks/swift/Package.swift`, and there is no root-level `Package.swift`
(verified: `ls /Package.swift` → not found; `git ls-remote --tags origin`
returns zero tags today, corroborated independently by
`proxy.golang.org/.../sdks/go/@v/list` also returning empty for the go
module). So **neither** tag scheme lets a consumer resolve this monorepo
directly via `.package(url: "https://github.com/FireWeave-HQ/fireweave-sdk", from:)`
today, regardless of prefix — a bare `vX.Y.Z` buys no actual SwiftPM
resolution benefit. Meanwhile a bare, unprefixed tag WOULD collide with any
other component that ever adopts one (git tags are a single global
namespace across this polyglot repo), which is exactly the reason the org
convention exists. `swift/v<semver>` costs nothing and keeps every tool
(`changelog.sh`, `version.sh`, `release.yml`) uniform. If/when Swift
consumption is unlocked (e.g. a dedicated mirror repo with `Package.swift` at
its root), that mirror can adopt whatever tag scheme its own resolution
needs — the tag inside THIS repo stays the internal release identity.

### Signed tags

Org convention is a **signed** annotated tag. GitHub-hosted runners have no
org signing identity, so today the workflow pushes an unsigned annotated tag
(non-dry runs only) and the release owner must re-sign locally:

```sh
git tag -s -f server/v0.1.0 -m "Release server/v0.1.0" <commit>
git push --force origin refs/tags/server/v0.1.0
```

Longer term: provision a bot GPG key (or adopt sigstore `gitsign`) and move
signing into the workflow.

## Registries (target state)

| Ecosystem | Registry | Name | Status |
| --- | --- | --- | --- |
| server (npm) | npmjs.com | `@fireweaveai/server-sdk` | Publish via **OIDC trusted publishing** (no long-lived `NPM_TOKEN`). |
| web (npm) | npmjs.com | `@fireweaveai/web-sdk` | Publish via **OIDC trusted publishing**. |
| Python | pypi.org | `fireweave` | Publish via **`PYPI_API_TOKEN`** GitHub secret (environment `release`) with `pypa/gh-action-pypi-publish`. Preferred auto path: push tag `python/v<semver>` → `publish-python.yml`. Staging goes to **TestPyPI** via `TEST_PYPI_API_TOKEN` (environment `release-staging`). |
| Go | proxy.golang.org | `github.com/FireWeave-HQ/fireweave-sdk/sdks/go` | No registry credentials — "publishing" is pushing the `sdks/go/v*` tag on the public repo; the proxy picks it up. |
| Java | Maven Central | groupId `ai.fireweave` | **Pending namespace verification** on the Central portal (DNS TXT proof for `fireweave.ai`). Workflows are release-ready and fail closed without secrets. Do not claim a coordinate is published until Central confirms. |
| Rust | crates.io | `fireweave` | Publish via **`CARGO_REGISTRY_TOKEN`** GitHub secret (environment `release`). No staging registry exists — see "Pre-release channels". |
| Swift | — | — | No package registry is used; consumption is git-tag-only, and (see "Tag convention") not currently resolvable as a direct SwiftPM dependency against this repo at all. |

## Pre-release channels

Staging identity is a **version suffix**, not a mutable pointer: a staging
release is `X.Y.Z-staging.N`, where `N` is the next unused iteration for
that base version as read from the ecosystem's own registry (see
`tools/release/version.sh`). This replaced an earlier npm-dist-tag-only
design — a dist-tag is a pointer that can be repointed from staging to
production on the exact same bytes, and the installed artifact records
nothing about which channel produced it. Putting the channel in the version
string itself means `npm ls` / `pip show` / `cargo tree` all show the truth.

npm still requires an explicit `--tag` on every publish regardless (it
defaults an untagged publish to `latest` even for a prerelease version) —
that tag is now pure syntax, not the channel signal:

| Ecosystem | `channel: staging` | Promotion to production |
| --- | --- | --- |
| npm (server, web) | publish `X.Y.Z-staging.N`, `--tag next` (`npm install @fireweaveai/server-sdk@next`) | fresh `channel: production` run computes the plain `X.Y.Z`, published `--tag latest` |
| PyPI | upload `X.Y.ZaN` to **TestPyPI** (`test.pypi.org`) — PEP 440 alpha; `-staging.N` is not a valid packaging version | push tag `python/vX.Y.Z` (preferred) or re-run `release.yml` with `channel: production` |
| Maven | deploy the **plain** `X.Y.Z` to the Central portal (`autoPublish=false` on staging — no separate staging registry or credentials exist, so there is no version-collision risk to guard against the way there is for the others). Validate in the portal, then release. | `autoPublish=true` on production / tag `java/v*` |
| crates.io (rust) | **no publish at all** — `cargo publish --dry-run` proves `X.Y.Z-staging.N` packages cleanly, plus the git tag. crates.io has no TestPyPI equivalent, and yanking is not deletion, so an actual staging upload would spend the version permanently. | fresh `channel: production` run computes the plain `X.Y.Z` and runs `cargo publish` for real (`CARGO_REGISTRY_TOKEN`) |
| Go | tag `sdks/go/vX.Y.Z-staging.N` (`go get` will not auto-select a prerelease tag); optional proxy warm | tag the final `sdks/go/vX.Y.Z` |
| Swift | tag `swift/vX.Y.Z-staging.N` — no publish step exists for swift at any channel; the tag IS the release | tag the final `swift/vX.Y.Z` |

## GitHub environments

Two environments, not one — production tokens must be unreachable from a
staging run, so a workflow bug cannot publish to PyPI when the operator
believed they were hitting TestPyPI:

| Environment | Used by | Secrets | Required reviewers |
| --- | --- | --- | --- |
| `release` | `publish-pypi-production`, `publish-maven` (BOTH channels — see below), `publish-cargo-production` | `PYPI_API_TOKEN`, `MAVEN_CENTRAL_USERNAME`/`_PASSWORD`, `MAVEN_GPG_PRIVATE_KEY`/`_PASSPHRASE`, `CARGO_REGISTRY_TOKEN` | **Yes** — this is the gate that must stay a human approval |
| `release-staging` | `publish-npm`, `publish-npm-web`, `publish-pypi`, `publish-go`, `publish-cargo` | `TEST_PYPI_API_TOKEN` (npm/go/cargo-dry-run need no secret — OIDC or none) | No |

**Java is the one exception**: Maven Central Portal has no separate staging
registry or credential set — `autoPublish=false` vs `true` is what makes a
staging deploy non-final, not a different secret — so `publish-maven` stays
on `environment: release` for both `channel: staging` and
`channel: production`. This means a java STAGING run also requires reviewer
approval, unlike every other ecosystem's staging path; that is the accepted
cost of not having a second Maven credential set to protect.

### Creating the environments (operator action — cannot be done from a coding session)

1. Repo **Settings → Environments → New environment**, name exactly
   `release`. Add **Required reviewers** (the human approval gate). Add
   secrets: `PYPI_API_TOKEN`, `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`,
   `MAVEN_GPG_PRIVATE_KEY`, `MAVEN_GPG_PASSPHRASE`, `CARGO_REGISTRY_TOKEN`.
2. Repo **Settings → Environments → New environment**, name exactly
   `release-staging`. Do **NOT** add required reviewers (staging must stay
   fast). Add secret: `TEST_PYPI_API_TOKEN`.
3. `TEST_PYPI_API_TOKEN`: create at
   [test.pypi.org → Account settings → API tokens](https://test.pypi.org/manage/account/#api-tokens),
   scoped to project `fireweave` (or account-wide for the first-ever upload,
   then narrow it once the project exists). Paste into the
   `release-staging` environment secret of the same name.
4. `CARGO_REGISTRY_TOKEN`: create at
   [crates.io → Account settings → API Tokens](https://crates.io/settings/tokens),
   scope "publish-update" on crate `fireweave` (or unscoped for the
   first-ever publish). Paste into the `release` environment secret of the
   same name.

If either job runs before its secret exists, it fails closed with an
explicit `::error::` naming the missing secret and the environment it
belongs on (see `publish-pypi`'s "Require TEST_PYPI_API_TOKEN" step and
`publish-cargo-production`'s "Require CARGO_REGISTRY_TOKEN" step) — it never
silently skips or falls back to an unauthenticated attempt.

## Company-side provisioning required before enabling publishing

1. **npm**: create the `@fireweaveai` org scope; add a trusted publisher for
   `FireWeave-HQ/fireweave-sdk` → workflow `release.yml` (OIDC), for BOTH
   `@fireweaveai/server-sdk` and `@fireweaveai/web-sdk`. No token secret
   needed. First-ever publish of a new package may require a one-time
   granular token with 2FA.
2. **PyPI + TestPyPI**: reserve / create the project name `fireweave`; add
   **trusted publishers** (OIDC — no token secret) on both indexes, OR use
   the token secrets above (this repo's workflows accept either):

   | Index | Workflow file | Environment |
   | --- | --- | --- |
   | **pypi.org** (production) | `publish-python.yml` | `release` |
   | **pypi.org** (optional alternate) | `release.yml` | `release` |
   | **test.pypi.org** (staging) | `release.yml` | `release-staging` |

   Field values for each publisher:
   - Owner: `FireWeave-HQ`
   - Repository: `fireweave-sdk`
   - Workflow name: exact filename above (e.g. `publish-python.yml`)
   - Environment name: as listed above (must match the job's `environment:`)

   Pending publishers are supported: configure before the first upload and the
   project is created on first successful publish.
3. **Maven Central**: verify namespace `ai.fireweave` (portal + DNS TXT);
   generate portal user tokens → `release` environment secrets
   `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`; provision a release
   GPG key → `release` environment secrets `MAVEN_GPG_PRIVATE_KEY`,
   `MAVEN_GPG_PASSPHRASE`. The parent POM will also need the Central
   publishing plugin + sources/javadoc/gpg plugins (Agent I / orchestrator
   change, outside `.github/` ownership).
4. **crates.io**: reserve / create the crate name `fireweave`; generate an
   API token → `release` environment secret `CARGO_REGISTRY_TOKEN` (see
   "Creating the environments" above for the exact steps).
5. **GitHub repo settings**: allow GitHub Actions to create and approve
   attestations (for `actions/attest-build-provenance`); create the two
   protected environments described above (`release` with required
   reviewers, `release-staging` without) and point the publish jobs at them
   (already done in `release.yml` — this step is about the environments and
   their secrets/reviewers existing, not workflow edits).
6. **Signing**: bot GPG key or gitsign for signed tags (above).
7. **Branch/tag protection**: protect `master` and `*/v*` tags so only the
   release workflow/owners can push tags.

## Rollback

Publishing is append-only almost everywhere; **prefer publishing a fixed
`x.y.z+1` over unpublishing**.

| Ecosystem | Rollback reality |
| --- | --- |
| npm | `npm unpublish` only within 72h and subject to policy; otherwise `npm deprecate @fireweaveai/server-sdk@<ver> "broken — use <ver+1>"` (or `web-sdk`) and repoint `latest`: `npm dist-tag add @fireweaveai/server-sdk@<good> latest`. |
| PyPI | Cannot re-upload a yanked version's file names. Use `yank` (pip stops selecting it by default) via the project UI/API, then release a fixed version. |
| Maven Central | Published artifacts are **immutable and cannot be removed**. Staged (not yet released) deployments can be dropped in the portal. Only fix-forward. |
| crates.io | Cannot delete a published version. `cargo yank` stops it from being selected by new lockfiles (existing `Cargo.lock` files are unaffected); publish a fixed version. |
| Go proxy | Cannot delete cached versions. Publish a fixed version, or in emergencies add a `retract` directive to `sdks/go/go.mod` and release it in the next tag — `go` tooling then warns on the retracted versions. |
| Swift | No registry to roll back — consumers pin an exact tag; publish a fixed tag and tell consumers to move to it. |
| Git tags | If a bad tag was pushed but nothing published: delete the tag (`git push origin :refs/tags/<tag>`). If any registry consumed it, treat the version as burned; never re-use a version number. |

Always accompany a rollback with: a changelog entry in the next release, a
GitHub release note edit marking the version broken, and (npm/PyPI/crates.io)
a deprecation/yank so resolvers steer clear.

## Local dry runs

Everything CI does at release-build time can be exercised locally:

```sh
scripts/build-all.sh                       # node/python/go/java package dry runs + SHA256SUMS
tools/release/changelog.sh server 0.1.0    # changelog preview to stdout
tools/release/version.sh compute server patch staging   # read -> bump -> compute, no writes
bash tools/release/version.test.sh         # offline unit tests for version.sh
scripts/test-all.sh && scripts/conformance-all.sh   # full release gate (same as the `verify` job)
```
