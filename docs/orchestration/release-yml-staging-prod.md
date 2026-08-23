# Release channels: staging vs production

Companion to [`.github/RELEASE.md`](../../.github/RELEASE.md) and
[`.github/workflows/release.yml`](../../.github/workflows/release.yml).

This note explains:

1. How staging and production are modeled (version + dist-tag).
2. A publish / install matrix for every component as `release.yml` works today.
3. How `release.yml` is structured.
4. What we manually tested on npm (2026-08-23).

---

## Channel model (npm)

Staging and production are **not** “repaint the same package with a different
dist-tag.” Each channel is a **separate publish** of a **different version**.

| Channel | Semver in `package.json` / registry | npm dist-tag | Typical install |
| --- | --- | --- | --- |
| Staging | `X.Y.Z-staging.N` | `next` | `npm i @scope/pkg@next` |
| Production | `X.Y.Z` | `latest` | `npm i @scope/pkg` |

**Source of truth for channel = version string** (`-staging.N`).

The dist-tag is **syntax only**: npm defaults an untagged publish to `latest`
even when the version is a prerelease. Publishing with `--tag next` (staging)
or `--tag latest` (production) avoids that footgun. Dist-tags are mutable
pointers; the installed artifact records the version, not which tag you used
at install time.

`N` is the next unused staging iteration for that base version, read from the
registry by `tools/release/version.sh` (not a local counter).

Promotion = a **new** production run that publishes plain `X.Y.Z`, not moving
`next` → `latest` on the same bytes.

---

## Publish / install matrix (as `release.yml` works today)

Common dispatch for every row:

- Actions → **Release (dry-run by default)**
- set `component`, `bump`, `channel`, and `dry_run=false`
- pipeline always runs **validate → build → verify → tag** before any publish job
- version computed by `tools/release/version.sh` (`*-staging.N` vs plain `X.Y.Z`)

| Component | Package / coordinate | Publish staging | Install staging | Publish production | Install production | Enabled in CI today? |
| --- | --- | --- | --- | --- | --- | --- |
| **server** (Node, `sdks/node`) | `@fireweaveai/server-sdk` | `channel=staging` → job `publish-npm` → version `X.Y.Z-staging.N`, `npm publish --tag next` (OIDC, env `release-staging`) | `npm i @fireweaveai/server-sdk@next` | Intended: `channel=production` → `--tag latest`, plain `X.Y.Z` | `npm i @fireweaveai/server-sdk` (or `@latest`) | Staging **yes**. Production **hard-disabled** (`publish-npm-production` `if: false`) |
| **web** | `@fireweaveai/web-sdk` | `channel=staging` → `publish-npm-web` → `*-staging.N`, `--tag next` | `npm i @fireweaveai/web-sdk@next` | Same as server (intended `--tag latest`) | `npm i @fireweaveai/web-sdk` | Staging **yes**. Production **hard-disabled** (same stub job) |
| **python** | `fireweave` | `channel=staging` → `publish-pypi` → TestPyPI (`TEST_PYPI_API_TOKEN`, env `release-staging`), version `X.Y.ZaN` (PEP 440; not `-staging.N`) | `pip install -i https://test.pypi.org/simple/ --extra-index-url https://pypi.org/simple/ 'fireweave==X.Y.ZaN'` | `channel=production` → `publish-pypi-production` → PyPI (`PYPI_API_TOKEN`, env `release`); also tag path `python/vX.Y.Z` → `publish-python.yml` | `pip install fireweave` or `pip install fireweave==X.Y.Z` | Staging **yes**. Production **yes** (needs secrets / reviewers on `release`) |
| **java** | `ai.fireweave:fireweave-sdk` (etc.) | `channel=staging` → `publish-maven` → Central portal with `autoPublish=false` (env `release`, reviewers required even for staging) | Pull from portal/staging deployment once available (Maven Central coordinates after release); validate in [Central Portal](https://central.sonatype.com) first | `channel=production` → same job with `autoPublish=true`; also tag `java/v*` → `publish-java.yml` | Maven/Gradle: `ai.fireweave:fireweave-sdk:X.Y.Z` from Maven Central | Both channels **wired**, but need namespace verification + `MAVEN_*` / `MAVEN_GPG_*` secrets (fail closed if missing) |
| **rust** | crates.io `fireweave` | `channel=staging` → `publish-cargo` → **`cargo publish --dry-run` only** (no crates.io upload) + git tag `rust/vX.Y.Z-staging.N` | **Cannot install from crates.io** for staging; use the git tag / path dependency if needed | `channel=production` → `publish-cargo-production` → real `cargo publish` (`CARGO_REGISTRY_TOKEN`, env `release`) | `cargo add fireweave` or `fireweave = "X.Y.Z"` in `Cargo.toml` | Staging = dry-run **yes**. Production **yes** (needs token) |
| **go** | `github.com/FireWeave-HQ/fireweave-sdk/sdks/go` | `channel=staging` → `tag` pushes `sdks/go/vX.Y.Z-staging.N`; job `publish-go` only warms the module proxy | `go get github.com/FireWeave-HQ/fireweave-sdk/sdks/go@vX.Y.Z-staging.N` (prereleases are not selected by default) | `channel=production` → `tag` pushes `sdks/go/vX.Y.Z` (no separate registry upload) | `go get github.com/FireWeave-HQ/fireweave-sdk/sdks/go@vX.Y.Z` | Staging tag + proxy warm **yes**. Production = git tag only (**yes** via `tag` job) |
| **swift** | git tag only (no registry) | `channel=staging` → `tag` pushes `swift/vX.Y.Z-staging.N` (no publish job) | Pin that git tag (note: SwiftPM cannot resolve this monorepo as a normal package today — `Package.swift` is under `sdks/swift/`, not repo root) | `channel=production` → `tag` pushes `swift/vX.Y.Z` | Pin that git tag (same monorepo limitation) | Tag-only for both (**yes** via `tag` job; no registry publish) |

### Dispatch examples

```text
# Staging Node
component=server, bump=patch, channel=staging,    dry_run=false

# Production Python
component=python, bump=patch, channel=production, dry_run=false

# Staging everything that staging jobs cover
component=all,    bump=patch, channel=staging,    dry_run=false
```

### Install cheatsheet (after a successful publish)

```bash
# npm staging / prod
npm i @fireweaveai/server-sdk@next
npm i @fireweaveai/server-sdk

# python staging / prod
pip install -i https://test.pypi.org/simple/ --extra-index-url https://pypi.org/simple/ 'fireweave==<ver>a<N>'
pip install 'fireweave==<ver>'

# rust prod only (staging is not on crates.io)
cargo add fireweave@<ver>

# go staging / prod (exact version)
go get github.com/FireWeave-HQ/fireweave-sdk/sdks/go@v<ver>-staging.<N>
go get github.com/FireWeave-HQ/fireweave-sdk/sdks/go@v<ver>
```

---

## How `release.yml` is structured today

### Trigger

`workflow_dispatch` only (no push-to-tag auto-release for the polyglot matrix).

| Input | Role |
| --- | --- |
| `component` | `server` \| `web` \| `python` \| `java` \| `go` \| `rust` \| `swift` \| `all` |
| `bump` | `patch` \| `minor` \| `major` (applied after stripping any existing prerelease) |
| `channel` | `staging` (default) or `production` |
| `dry_run` | `true` (default) = build/changelog/SBOM/checksums only; no tag, no publish |

Node lives under directory `sdks/node` but the release **component name is
`server`** (git tag prefix `server/v…`, package name intended as
`@fireweaveai/server-sdk`).

### Job graph

```
validate
   └─ build          # version.sh compute → release-info-<component> artifact
         └─ verify   # full scripts/{build,test,conformance}-all.sh
               └─ tag   # annotated git tag <component>/v<semver> (skipped if dry_run)
                     └─ publish-*   # gated by channel + component + dry_run
```

Version is computed **once** in `build` and reused by every `publish-*` job
via the `release-info` artifact (`version.sh apply`). Publish jobs must not
recompute (unsafe once the git tag already exists for go/java/swift).

### Separate runs, not one dual-publish

| Operator intent | Dispatch |
| --- | --- |
| Staging | `channel=staging`, `dry_run=false`, component e.g. `server` |
| Production | `channel=production`, `dry_run=false`, same component |

One dispatch never publishes both channels. Staging and production use
different GitHub Environments so production secrets are unreachable from a
staging run:

| Environment | Used for | Reviewers |
| --- | --- | --- |
| `release-staging` | staging publishes (npm OIDC, TestPyPI, cargo dry-run, Go proxy warm) | none |
| `release` | production secrets (PyPI, Maven, crates.io); required reviewers | yes |

### npm jobs (server + web)

| Job | Runs when | Behavior |
| --- | --- | --- |
| `publish-npm` | `dry_run=false` **and** `channel=staging` **and** component includes `server` | Apply version → build → `npm publish --provenance --access public --tag "$DIST_TAG"` (`DIST_TAG=next`) on `environment: release-staging`, OIDC (`id-token: write`) |
| `publish-npm-web` | same, for `web` | Same pattern for `@fireweaveai/web-sdk` |
| `publish-npm-production` | **`if: false`** | Hard-disabled stub until a second written authorization for `latest` |

So today CI can publish npm **staging only**. Production npm is blocked in
the workflow even if you select `channel=production`.

Auth target state: npm **trusted publisher** (OIDC) for
`FireWeave-HQ/fireweave-sdk` → workflow `release.yml`. No long-lived
`NPM_TOKEN` in CI once provisioned. Still requires the `@fireweaveai` org
scope to exist on npmjs.com.

### Other ecosystems (same `channel` input)

| Ecosystem | Staging | Production |
| --- | --- | --- |
| Python | TestPyPI, `X.Y.ZaN` (PEP 440) | PyPI (also tag workflow `publish-python.yml` / `python/v*`) |
| Rust | `cargo publish --dry-run` only (+ git tag) | real `cargo publish` (`CARGO_REGISTRY_TOKEN`) |
| Go | git tag `sdks/go/v*-staging.N` + optional proxy warm | git tag plain |
| Swift | git tag `swift/v*-staging.N` (tag is the release) | git tag plain |
| Java | Central portal, `autoPublish=false` | Central, `autoPublish=true` |

---

## What we tested manually (2026-08-23)

Goal: validate the staging/prod **version + dist-tag** model end-to-end on a
real registry, independent of CI OIDC / `@fireweaveai` org provisioning.

### Setup notes

- Official package name in-repo docs/workflows: `@fireweaveai/server-sdk`.
- The npm org `@fireweaveai` did **not** exist at test time; first publish
  under that scope returned `E404`.
- For the experiment, `sdks/node/package.json` `name` was temporarily set to
  `@prioby0121/server-sdk` and published with a personal access token (token
  was exposed in chat — **revoke/rotate**; do not reuse).
- Build prerequisite: `npm install` in `sdks/node` (missing `@types/node`
  caused `TS2688` before install).

### Publishes

| Step | Version | Command | Dist-tag after |
| --- | --- | --- | --- |
| Initial | `2.1.0` | `npm publish --access public` | `latest` → `2.1.0` |
| Staging | `2.1.1-staging.0` | `npm publish --access public --tag next` | `next` → `2.1.1-staging.0` |
| Production | `2.1.1` | `npm publish --access public --tag latest` | `latest` → `2.1.1` |

Registry result (verified):

```text
versions:  2.1.0, 2.1.1-staging.0, 2.1.1
dist-tags: latest=2.1.1, next=2.1.1-staging.0
```

Install checks:

```bash
npm i @prioby0121/server-sdk@next    # → 2.1.1-staging.0
npm i @prioby0121/server-sdk         # → 2.1.1 (latest)
```

Package page: https://www.npmjs.com/package/@prioby0121/server-sdk

### Alignment with `release.yml`

| Manual test | Workflow equivalent |
| --- | --- |
| Bump to `*-staging.N` + `--tag next` | `channel=staging` → `version.sh` sets version + `dist_tag=next` → `publish-npm` |
| Bump to plain `X.Y.Z` + `--tag latest` | `channel=production` → `dist_tag=latest` → **`publish-npm-production` (disabled today)** |
| Personal token | CI uses OIDC trusted publisher (no token) once org + publisher configured |
| `@prioby0121/...` | Intended production scope remains `@fireweaveai/...` |

### Local tree after the experiment

`sdks/node/package.json` may still show the temporary name/version used for
publishing (`@prioby0121/server-sdk`, `2.1.1`). Revert to
`@fireweaveai/server-sdk` (and the intended manifest version) before merging
any release automation work aimed at the org scope.

---

## Operator cheat sheet

**Staging (intended CI path, once OIDC + org exist):**

1. Actions → **Release (dry-run by default)**
2. `component=server`, `bump=…`, `channel=staging`, `dry_run=false`
3. Expect git tag `server/vX.Y.Z-staging.N` and npm `@fireweaveai/server-sdk@next`

**Production npm (workflow still blocked):**

1. Requires flipping `publish-npm-production` off `if: false` after written auth
2. Then: `channel=production`, `dry_run=false`
3. Expect plain `X.Y.Z` and `--tag latest`

**Local dry-run helpers** (no registry upload):

```bash
tools/release/version.sh compute server patch staging
tools/release/version.sh compute server patch production
scripts/build-all.sh
```

---

## Related files

| Path | Role |
| --- | --- |
| `.github/workflows/release.yml` | Channel gates + publish jobs |
| `.github/RELEASE.md` | Canonical release process / environments / provisioning |
| `tools/release/version.sh` | Compute / apply version + `dist_tag` |
| `sdks/node/package.json` | Node / server npm manifest |
