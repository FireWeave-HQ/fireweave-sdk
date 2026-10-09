# Fireweave SDK — Release Process

Owner: release engineering (scope: `.github/`, `scripts/`, `tools/`).

Status (2026-07-27): **staging publish authorized** for npm
(`@fireweaveai/server-sdk`, dist-tag `next`), TestPyPI (`fireweave`), and Go
proxy warm — only when `workflow_dispatch` has `dry_run=false` and
`channel=staging`.

Status (2026-08-21): staging publish SCOPE EXTENDED to also cover npm for
`@fireweaveai/web-sdk` (dist-tag `next` — identical OIDC trusted-publish
mechanism as the already-authorized `server-sdk`) and a rust
`cargo publish --dry-run` (packages + validates only; no crates.io upload —
see "Pre-release channels"), under the same `dry_run=false` /
`channel=staging` gate.

Status (2026-09-02, during the dart-sdk implementation work — **not** a
separate human authorization; flagged for a human to confirm the same way the
2026-08-21 extension was): a `dart` component was added under the same
gates — staging is a `dart pub publish --dry-run` (validates only; pub.dev
has no staging registry, and a published version can only be retracted, never
deleted) plus the git tag; production publishes to pub.dev via pub.dev's own
OIDC "automated publishing" on `environment: release`, which pub.dev rejects
until it is enabled for the package (fail-closed; see "Registries").

Status (2026-10-09, owner decisions O1–O10): **staging builds are `X.Y.Z-rc.N`**
(Python `X.Y.ZrcN`) from 3.0.0 on, and `-staging.N` is no longer a staging
spelling (see "Migration from `-staging.N`"). Python staging moved from
TestPyPI to **PyPI**; Java staging publishes `X.Y.Z-rc.N` to **Maven
Central**; Swift is out of `all` and of every rc cut until the Swift mirror
exists. Both registries' pre-release risks are accepted in writing (see
"Pre-releases on production registries"). The tag-push triggers of
`publish-java.yml` and `publish-python.yml` are retired: `release.yml`
dispatch is the only routine publish path.

**Production PyPI** is enabled for `fireweave` via `release.yml` with
`component=python`, `channel=production`, `dry_run=false`.
[`publish-python.yml`](workflows/publish-python.yml) is a dispatch-only manual
recovery path for a plain version (its `python/v*` tag-push trigger is
retired).

**Production npm** (`latest`, both `@fireweaveai/server-sdk` and
`@fireweaveai/web-sdk`) is **enabled** as of 2026-09-09 — that date is the
"second written authorization" the previous hard-disable was waiting on.
`release.yml` with `channel=production`, `dry_run=false` and the matching
component runs `publish-npm-server-production` / `publish-npm-web-production`
on environment `release`, publishing `--tag latest` via the same OIDC trusted
publisher staging already uses. **The npm Trusted Publisher for each package
must permit the `release` environment**. **Maven Central** is
wired through `release.yml` (`component=java`) using the Central Publisher
Portal plugin; [`publish-java.yml`](workflows/publish-java.yml) is a
dispatch-only manual recovery path for a plain version (its `java/v*`
tag-push trigger is retired). Missing secrets fail closed rather than publishing a
broken artifact. **crates.io** production publish requires
`CARGO_REGISTRY_TOKEN` — same fail-closed behavior.

## Overview

One release = one component (`server` | `web` | `python` | `java` | `go` |
`rust` | `swift` | `dart`, or `all` to fan out every component except swift
via a matrix) at one computed semver. Swift returns to `all` once the Swift
mirror and `SWIFT_MIRROR_DEPLOY_KEY` exist ("Company-side provisioning"); until
then a staging `component=swift` is refused in `validate`. Trigger
[`Release (dry-run by default)`](workflows/release.yml) via `workflow_dispatch`:

**`all` is not only a build-time convenience — with `dry_run=false` and
`channel=staging` it fires every staging publish job at once, unattended**
(both npm packages, the Go proxy warm, the rust `cargo --dry-run`, and the
dart `dart pub publish --dry-run`): `release-staging` carries no
required-reviewer gate, so selecting `all` there is the same as approving all
of them in one click, not just requesting seven builds. The Python (PyPI) and
Java (Maven Central) rc publishes run on `release` and still wait for its
reviewer approval.

| Input | Meaning |
| --- | --- |
| `component` | Which SDK to release (`all` fans out via matrix) |
| `bump` | `patch` \| `minor` \| `major` — applied to the component's OWN current manifest version by `tools/release/version.sh` (any existing prerelease is stripped first; there is no free-text `version` input) |
| `channel` | `staging` (default, version `X.Y.Z-rc.N`, Python `X.Y.ZrcN`) or `production` (plain `X.Y.Z`) — see pre-release channels |
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
65×8 cross-language differential gate CI runs) — a release cannot publish
without these gates passing, dry run or not.

## Versioning: `tools/release/version.sh`

`tools/release/version.sh` is the single source of truth for "what version
does this release actually carry." Two subcommands:

- `version.sh compute <component> <bump> <channel>` — reads the component's
  current version (from its manifest, or, for go/swift — which carry no
  version field — the highest existing plain `<prefix>/vX.Y.Z` tag,
  defaulting to `0.0.0` when none exists), strips any existing prerelease,
  applies `<bump>`, and (channel=staging only) appends `-rc.N` (Python
  `rcN`) where `N` is the next unused rc iteration for that base, queried live
  from the component's registry (npm / pypi.org / pub.dev / `git ls-remote`
  against `origin` for go, java, rust, and swift — see the script's own
  header for why those use the tag list). Legacy `-staging.N` / `aN` versions
  never count, so the first rc of a base is `rc.1`. A staging version without
  the rc spelling is refused. Prints `key=value` lines; never writes anything.
- `version.sh apply <component> <release-version>` — writes an
  ALREADY-COMPUTED version into the component's manifest (no bump math, no
  network). go/swift are a documented no-op — the git tag already pushed by
  `build` is the version record.
- `version.sh check-stamp <component> <channel>` — run after `apply` in every
  publish job: fails unless the stamped workspace calls `<channel>` (the
  build-info stamp for server/web/dart/swift; the manifest or tag version
  through the SP-13 rule for rust/java/python/go). Nothing irreversible
  publishes before it passes.

`build` calls `compute` once per selected component and uploads the result
as a small `release-info-<component>` artifact; every `publish-*` job
downloads that artifact and calls `apply` with the same value, rather than
recomputing — see the workflow's own header comment for why recomputing
inside a publish job is unsafe for go/java/swift specifically (their
"registry" is the git tag list, which `build` has, by that point, already
changed by pushing the new tag).

Local, offline: `bash tools/release/version.test.sh` (pure semver logic —
strip-prerelease, bump, rc-N extraction, the stamps and `check-stamp` — plus
end-to-end `compute` runs with the registry query stubbed out; zero network
calls).

## Tag convention

Org convention `<component>/v<semver>`, with one forced exception:

| Component | Tag | Why |
| --- | --- | --- |
| server | `server/v0.1.0` | org convention (renamed from `node` — package is `@fireweaveai/server-sdk`; directory stays `sdks/node`) |
| web | `web/v0.1.0` | org convention |
| python | `python/v0.1.0` | org convention |
| java | `java/v0.1.0` | org convention |
| rust | `rust/v0.1.0` | org convention |
| swift | `swift/v0.1.0` | org convention — chosen deliberately over a bare `vX.Y.Z`; see below |
| dart | `dart/v0.1.0` | org convention — pub.dev resolves packages by version from its own registry, never by git tag, so the prefix costs nothing |
| go | `sdks/go/v0.1.0` | **Go toolchain requirement**: a module in subdirectory `sdks/go` is only resolvable when the tag prefix equals the subdirectory path. `go/v0.1.0` would not resolve. |

**Why swift uses `swift/v<semver>` and not a bare `vX.Y.Z`:** SwiftPM's git
dependency resolution (`.package(url:, from:)`) requires `Package.swift` at
the ROOT of the referenced repository — there is no first-party "subdirectory"
parameter the way Go modules have one. This repo's `Package.swift` lives at
`sdks/swift/Package.swift`, and there is no root-level `Package.swift`
(verified: `ls /Package.swift` → not found). So **neither** tag scheme lets a consumer resolve this monorepo
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

## Registries

| Ecosystem | Registry | Name | Status |
| --- | --- | --- | --- |
| server (npm) | npmjs.com | `@fireweaveai/server-sdk` | Publish via **OIDC trusted publishing** (no long-lived `NPM_TOKEN`). |
| web (npm) | npmjs.com | `@fireweaveai/web-sdk` | Publish via **OIDC trusted publishing**. |
| Python | pypi.org | `fireweave` | Publish via **`PYPI_API_TOKEN`** GitHub secret (environment `release`) with `pypa/gh-action-pypi-publish`, from `release.yml` on both channels: staging uploads `X.Y.ZrcN`, production the plain version. `publish-python.yml` is dispatch-only manual recovery for a plain version. |
| Go | proxy.golang.org | `github.com/FireWeave-HQ/fireweave-sdk/sdks/go/v3` | No registry credentials — "publishing" is pushing the `sdks/go/v*` tag on the public repo; the proxy picks it up. **Major ≥ 2 requires the `/vN` module-path suffix, e.g. `/v3`** (Go modules rule); the git tag prefix stays `sdks/go/`. |
| Java | Maven Central | groupId `ai.fireweave` | Published from `release.yml` on both channels (staging `X.Y.Z-rc.N`); fails closed without secrets. `publish-java.yml` is dispatch-only manual recovery for a plain version. |
| Rust | crates.io | `fireweave` | Publish via **`CARGO_REGISTRY_TOKEN`** GitHub secret (environment `release`). No staging registry exists — see "Pre-release channels". |
| Swift | mirror repository (`vars.SWIFT_MIRROR_REPO`, default `FireWeave-HQ/fireweave-swift`) | `.package(url:, from:)` on the mirror | No package registry; SwiftPM resolves the mirror's root `Package.swift` and plain semver tags, which `publish-swift-mirror` pushes. Blocked until the mirror exists (provisioning below). |
| Dart | pub.dev | `fireweave` | Publish via pub.dev **automated publishing** (OIDC — no token secret; `dart-lang/setup-dart` exchanges the GitHub id-token). Must be enabled on pub.dev for the package, bound to this repository, `release.yml`, and the `release` environment; until then pub.dev rejects the publish. No staging registry exists — see "Pre-release channels". |

## Pre-release channels

Staging identity is a **version suffix**, not a mutable pointer: a staging
release is `X.Y.Z-rc.N` (Python `X.Y.ZrcN`), where `N` is the next unused rc
iteration for that base version as read from the ecosystem's own registry or
tag list (see `tools/release/version.sh`). This replaced an earlier
npm-dist-tag-only design — a dist-tag is a pointer that can be repointed from
staging to production on the exact same bytes, and the installed artifact
records nothing about which channel produced it. Putting the channel in the
version string itself means `npm ls` / `pip show` / `cargo tree` all show the
truth. In FireWeave SDKs **`rc` means "a pre-release that calls the staging
fw-server"** (spec SP-13): no production pre-release exists, and
`version.sh` refuses any suffix on a production version.

npm still requires an explicit `--tag` on every publish regardless (it
defaults an untagged publish to `latest` even for a prerelease version) —
that tag is now pure syntax, not the channel signal:

| Ecosystem | `channel: staging` | Promotion to production |
| --- | --- | --- |
| npm (server, web) | publish `X.Y.Z-rc.N`, `--tag next` (`npm install @fireweaveai/server-sdk@next`; pin the exact version it resolves) | fresh `channel: production` run computes the plain `X.Y.Z`, published `--tag latest` |
| PyPI | upload `X.Y.ZrcN` (PEP 440 release candidate) to **PyPI**, environment `release`. pip, uv, poetry and pipenv ignore it unless the requirement pins it exactly (`pip install fireweave==X.Y.ZrcN`), so `pip install fireweave` keeps the latest final release | `release.yml` with `channel: production` only (the `python/v*` tag push is retired) |
| Maven | publish `X.Y.Z-rc.N` to Maven Central (`autoPublish=true`; decision D4, ADR-0012, reaffirmed 2026-10-09). The workflow refuses a staging run whose version lacks `-rc.`. Each rc is permanent on Central, and a Maven range or Gradle dynamic version can resolve it (see "Pre-releases on production registries") | fresh `channel: production` run publishes the plain `X.Y.Z` |
| crates.io (rust) | **no publish at all** — `cargo publish --dry-run` proves `X.Y.Z-rc.N` packages cleanly, plus the git tag (on a release commit carrying the version, see "Release commits"). crates.io has no TestPyPI equivalent, and yanking is not deletion, so an actual staging upload would spend the version permanently. | fresh `channel: production` run computes the plain `X.Y.Z` and runs `cargo publish` for real (`CARGO_REGISTRY_TOKEN`) |
| Go | tag `sdks/go/vX.Y.Z-rc.N` (`go get` will not auto-select a prerelease tag); optional proxy warm | tag the final `sdks/go/vX.Y.Z` |
| Swift | **excluded from rc cuts** until the Swift mirror and `SWIFT_MIRROR_DEPLOY_KEY` exist (`all` omits swift; a staging `component=swift` is refused in `validate`). Once it ships: `publish-swift-mirror` copies `sdks/swift` (with `BuildInfo.swift` stamped) to the mirror repository's root and tags it `X.Y.Z-rc.N` there (decision D5, ADR-0012); the monorepo keeps `swift/vX.Y.Z-rc.N` | the same job tags the plain `X.Y.Z` in the mirror |
| pub.dev (dart) | **no publish at all** — `dart pub publish --dry-run` proves `X.Y.Z-rc.N` packages cleanly, plus the git tag (on a release commit carrying the stamp, see "Release commits"). pub.dev has no staging registry, and a published version can only be retracted (within 7 days) — never deleted — so an actual staging upload would spend the version permanently. | fresh `channel: production` run computes the plain `X.Y.Z` and runs `dart pub publish --force` for real (OIDC automated publishing) |

### Pre-releases on production registries (accepted risk)

Java and Python rc builds live on the same registries as releases, so
something other than an exact pin can reach them:

- **Java (Maven Central).** `X.Y.Z-rc.N` sorts below its own release, but
  Maven ranges (`[3.0,)`, `[3.0.0,4.0.0)`), Gradle dynamic versions (`3.+`,
  `latest.release`) and Central's `maven-metadata.xml` `<latest>` /
  `<release>` all include qualifier versions. Before `3.0.0` exists a range
  resolves `3.0.0-rc.1`; after it, `3.1.0-rc.1` outranks `3.0.0`.
- **Python (PyPI).** `X.Y.ZrcN` is reachable by `pip install --pre`, a
  pre-release specifier (`>=3.0.0rc1`, `~=3.0.0rc1`) or uv
  `--prerelease allow`.

Either way the app gets an rc, which calls the **staging** fw-server, and the
version is permanent (a PyPI version can be yanked, never reused; a Central
version cannot be removed). Accepted by the owner on 2026-10-09 (O3, O5).
Users who want production write an exact plain version; the FireWeave
installer always writes exact versions and never a range.

### Release commits

Rust and Dart staging builds are consumed straight from their git tag (no
registry upload), and Swift releases are tag-only too, so the `tag` job runs
`version.sh release-commit <component> <version>` for `rust`, `dart` and
`swift`: it applies the version, runs `check-stamp`, and commits the result
on a detached HEAD (`release(<component>): <version>`). The tag points at that
commit, so a consumer of the tag builds the stamped version; `main` is never
touched. The other components tag the checkout: Go's tag is its version, and
server/web/python/java consumers use the registry artifact, stamped in the
publish job.

### Migration from `-staging.N`

The staging spelling changed after `3.0.0-staging.1` / Python `3.0.0a1`:

- From 3.0.0 on, `-staging.` is **not** a staging spelling. The semver SDKs'
  rule is "contains `-rc.`"; a build published earlier keeps the rule (or
  stamp) it shipped with.
- **The ordering trap.** SemVer sorts `3.0.0-staging.1` above every
  `3.0.0-rc.N` (`r` < `s`), so "the highest pre-release" and caret ranges
  pick it. npm `3.0.0-staging.1` (both packages) is deprecated once rc.1
  publishes, and staging installs pin the exact rc.
- **Go.** The proxy keeps `v3.0.0-staging.1` as `@latest` until `v3.0.0`,
  whose `go.mod` retracts it. Until then every Go pseudo-version of `main` is
  `v3.0.0-staging.1.0.<timestamp>-<sha>` and calls production, like any
  untagged development build.
- **Rust and Dart.** `rust/v3.0.0-staging.1` and `dart/v3.0.0-staging.1`
  point at an unstamped commit (`2.2.0`, `production`): an app on them calls
  production. They stay (lockfiles may reference them).
- **Java and Swift.** `java/v3.0.0-staging.1` and `swift/v3.0.0-staging.1`
  have no artifact behind them; the owner removes them once Central
  deployment `922e7f2c` is confirmed not published (owner release step, O8).
  Until then they are orphan tags. Release run 37928804993 is superseded:
  never re-run its Maven or Swift jobs.
- **Python.** TestPyPI `3.0.0a1` is the last TestPyPI upload; staging moves
  to `fireweave==X.Y.ZrcN` on PyPI.

## GitHub environments

Two environments, not one — production tokens must be unreachable from a
staging run wherever a separate staging credential exists:

| Environment | Used by | Secrets | Required reviewers |
| --- | --- | --- | --- |
| `release` | `publish-npm-server-production`, `publish-npm-web-production`, `publish-pypi` (staging rc) and `publish-pypi-production`, `publish-maven` (BOTH channels — see below), `publish-cargo-production`, `publish-pub-production`, `publish-swift-mirror` (production) | `PYPI_API_TOKEN`, `MAVEN_CENTRAL_USERNAME`/`_PASSWORD`, `MAVEN_GPG_PRIVATE_KEY`/`_PASSPHRASE`, `CARGO_REGISTRY_TOKEN`, `SWIFT_MIRROR_DEPLOY_KEY` (the two npm jobs and pub.dev need no secret — OIDC) | **Yes** — this is the gate that must stay a human approval |
| `release-staging` | `publish-npm`, `publish-npm-web`, `publish-go`, `publish-cargo`, `publish-pub`, `publish-swift-mirror` (staging) | `SWIFT_MIRROR_DEPLOY_KEY` (npm/go/cargo-dry-run/pub-dry-run need no secret — OIDC or none) | No |

The `tag` job runs on `release` for a production run and on
`release-staging` for a staging run. `TEST_PYPI_API_TOKEN` is retired: no
job reads it, and it can be deleted from `release-staging`.

**Java and Python are the two exceptions**: Maven Central Portal and PyPI
have no separate staging registry or credential set — a staging run
publishes an `X.Y.Z-rc.N` (Python `X.Y.ZrcN`) version with the production
credentials — so `publish-maven` and `publish-pypi` run on
`environment: release` for both `channel: staging` and `channel: production`.
This means a Java or Python STAGING run also requires reviewer approval,
unlike every other ecosystem's staging path; that is the accepted cost of not
having a second credential set to protect. The compute guard and
`check-stamp` refuse a non-rc version before either upload.

### Creating the environments (operator action — cannot be done from a coding session)

1. Repo **Settings → Environments → New environment**, name exactly
   `release`. Add **Required reviewers** (the human approval gate). Add
   secrets: `PYPI_API_TOKEN`, `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`,
   `MAVEN_GPG_PRIVATE_KEY`, `MAVEN_GPG_PASSPHRASE`, `CARGO_REGISTRY_TOKEN`.
2. Repo **Settings → Environments → New environment**, name exactly
   `release-staging`. Do **NOT** add required reviewers (staging must stay
   fast). No Python secret belongs here: Python staging uploads to PyPI with
   `PYPI_API_TOKEN` on `release` (`TEST_PYPI_API_TOKEN` is retired).
3. `PYPI_API_TOKEN`: create at
   [pypi.org → Account settings → API tokens](https://pypi.org/manage/account/#api-tokens),
   scoped to project `fireweave`. Paste into the `release` environment secret
   of the same name.
4. `CARGO_REGISTRY_TOKEN`: create at
   [crates.io → Account settings → API Tokens](https://crates.io/settings/tokens),
   scope "publish-update" on crate `fireweave`. Paste into the `release`
   environment secret of the same name.

If either job runs before its secret exists, it fails closed with an
explicit `::error::` naming the missing secret and the environment it
belongs on (see `publish-pypi`'s "Require PYPI_API_TOKEN" step and
`publish-cargo-production`'s "Require CARGO_REGISTRY_TOKEN" step) — it never
silently skips or falls back to an unauthenticated attempt.

## Company-side provisioning required

1. **Swift mirror** (decision D5): create the repository named by the
   `SWIFT_MIRROR_REPO` repository variable (default
   `FireWeave-HQ/fireweave-swift`), add a **write** deploy key to it, and store
   the private half as the `SWIFT_MIRROR_DEPLOY_KEY` secret in **both** the
   `release` and `release-staging` environments. Add a ruleset on the mirror so
   only that deploy key can push to its default branch and tags; nobody edits
   the mirror by hand. `publish-swift-mirror` fails closed until this exists.
2. **pub.dev**: publish the first `fireweave` version manually (pub.dev
   requires an initial human publish before automated publishing can be
   configured), then on the package's **Admin** tab enable **Automated
   publishing** from GitHub Actions with repository `FireWeave-HQ/fireweave-sdk`,
   tag pattern `dart/v{{version}}`, and **require the GitHub Actions
   environment** `release`. No token secret is involved; the `release`
   environment's required reviewers remain the human gate.
3. **GitHub repo settings**: allow GitHub Actions to create and approve
   attestations (for `actions/attest-build-provenance`); create the two
   protected environments described above (`release` with required
   reviewers, `release-staging` without) and point the publish jobs at them
   (already done in `release.yml` — this step is about the environments and
   their secrets/reviewers existing, not workflow edits).
4. **Signing**: bot GPG key or gitsign for signed tags (above).
5. **Branch/tag protection**: protect `main` and `*/v*` tags so only the
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
| pub.dev | Cannot delete a published version. **Retract** it within 7 days of publishing (`dart pub` → package Admin tab; retracted versions are excluded from resolution unless already pinned in a `pubspec.lock`), then publish a fixed version. After 7 days, only fix-forward. |
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
