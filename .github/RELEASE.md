# Fireweave SDK — Release Process

Owner: release engineering (Agent K scope: `.github/`, `scripts/`, `tools/`).
Status (2026-08-10): **staging publish authorized** for npm (`@fireweaveai/sdk`
dist-tag `next`), TestPyPI (`fireweave`), and Go proxy warm — only when
`workflow_dispatch` has `dry_run=false` and `channel=staging`. **Production
PyPI** is enabled for `fireweave` via:
- tag push `python/v<semver>` → [`.github/workflows/publish-python.yml`](workflows/publish-python.yml)
- or `release.yml` with `component=python`, `channel=production`, `dry_run=false`

**Production npm** (`latest`) remains hard-disabled (`if: false`) until a second
written authorization. **Maven Central** is wired through
[`publish-java.yml`](workflows/publish-java.yml) (tag `java/v*`) and
`release.yml` (`component=java`) using the Central Publisher Portal plugin.
The first upload still requires namespace verification for `ai.fireweave` plus
`MAVEN_CENTRAL_USERNAME` / `MAVEN_CENTRAL_PASSWORD` / `MAVEN_GPG_*` secrets —
missing secrets fail closed rather than publishing a broken artifact.

## Overview

One release = one component (`node` | `python` | `go` | `java`) at one semver.
Trigger [`Release (dry-run by default)`](workflows/release.yml) via
`workflow_dispatch`:

| Input | Meaning |
| --- | --- |
| `component` | Which SDK to release |
| `version` | Semver **without** leading `v` (e.g. `0.1.0`, `0.2.0-rc.1`) |
| `channel` | `staging` (default) or `production` — see pre-release channels |
| `dry_run` | `true` (default): build/changelog/SBOM/checksums only, no tag, no attestation |

The workflow always produces (as a CI artifact, never a registry upload):

- package artifacts (`npm pack` tarball, sdist+wheel, jars; Go ships via tags),
- `CHANGELOG-<component>-v<version>.md` generated from **conventional commits**
  (`tools/release/changelog.sh`, grouped feat/fix/perf/docs/breaking/other,
  scoped to the component's paths + shared `contracts/` + `spec/`),
- SPDX SBOM via syft (`anchore/sbom-action`),
- `SHA256SUMS` over every artifact,
- build provenance attestation (`actions/attest-build-provenance`, skipped in
  dry runs — requires repo attestation setting).

## Tag convention

Org convention `<component>/v<semver>`, with one forced exception:

| Component | Tag | Why |
| --- | --- | --- |
| node | `node/v0.1.0` | org convention |
| python | `python/v0.1.0` | org convention |
| java | `java/v0.1.0` | org convention |
| go | `sdks/go/v0.1.0` | **Go toolchain requirement**: a module in subdirectory `sdks/go` is only resolvable when the tag prefix equals the subdirectory path. `go/v0.1.0` would not resolve. |

### Signed tags

Org convention is a **signed** annotated tag. GitHub-hosted runners have no
org signing identity, so today the workflow pushes an unsigned annotated tag
(non-dry runs only) and the release owner must re-sign locally:

```sh
git tag -s -f node/v0.1.0 -m "Release node/v0.1.0" <commit>
git push --force origin refs/tags/node/v0.1.0
```

Longer term: provision a bot GPG key (or adopt sigstore `gitsign`) and move
signing into the workflow.

## Registries (target state)

| Ecosystem | Registry | Name | Status |
| --- | --- | --- | --- |
| Node | npmjs.com | `@fireweaveai/sdk` | Working name pending company ratification (ADR-0001). Publish via **OIDC trusted publishing** (no long-lived `NPM_TOKEN`). |
| Python | pypi.org | `fireweave` | Publish via **`PYPI_API_TOKEN`** GitHub secret (repo or `release` env) with `pypa/gh-action-pypi-publish`. Preferred auto path: push tag `python/v<semver>` → `publish-python.yml`. OIDC Trusted Publisher remains optional. |
| Go | proxy.golang.org | `github.com/FireWeave-HQ/fireweave-sdk/sdks/go` | No registry credentials — "publishing" is pushing the `sdks/go/v*` tag on the public repo; the proxy picks it up. |
| Java | Maven Central | groupId `ai.fireweave` | **Pending namespace verification** on the Central portal (DNS TXT proof for `fireweave.ai`). Workflows are release-ready and fail closed without secrets. Do not claim a coordinate is published until Central confirms. |

## Pre-release channels

| Ecosystem | `channel: staging` | Promotion to production |
| --- | --- | --- |
| npm | publish with dist-tag `next` (`npm install @fireweaveai/sdk@next`) | `npm dist-tag add @fireweaveai/sdk@<ver> latest` |
| PyPI | upload to **TestPyPI** (`test.pypi.org`) | push tag `python/vX.Y.Z` (preferred) or re-run `release.yml` with `channel: production` |
| Maven | deploy to Central **portal** (`org.sonatype.central:central-publishing-maven-plugin`; `autoPublish=false` on staging). Validate in the portal, then release. | `autoPublish=true` on production / tag `java/v*` |
| Go | pre-release semver tag (`sdks/go/v0.2.0-rc.1`) — Go treats `-rc.1` as a pre-release; `go get` won't auto-select it | tag the final `sdks/go/vX.Y.Z` |

## Company-side provisioning required before enabling publishing

1. **npm**: create the `@fireweaveai` org scope; ratify the package name; add a
   trusted publisher for `FireWeave-HQ/fireweave-sdk` → workflow
   `release.yml` (OIDC). No token secret needed. First-ever publish of a new
   package may require a one-time granular token with 2FA.
2. **PyPI + TestPyPI**: reserve / create the project name `fireweave`; add
   **trusted publishers** (OIDC — no token secret) on both indexes:

   | Index | Workflow file | Environment |
   | --- | --- | --- |
   | **pypi.org** (production) | `publish-python.yml` | `release` |
   | **pypi.org** (optional alternate) | `release.yml` | `release` |
   | **test.pypi.org** (staging) | `release.yml` | optional |

   Field values for each publisher:
   - Owner: `FireWeave-HQ`
   - Repository: `fireweave-sdk`
   - Workflow name: exact filename above (e.g. `publish-python.yml`)
   - Environment name: `release` (must match the job `environment:`)

   Pending publishers are supported: configure before the first upload and the
   project is created on first successful publish.
3. **Maven Central**: verify namespace `ai.fireweave` (portal + DNS TXT);
   generate portal user tokens → repo secrets `MAVEN_CENTRAL_USERNAME`,
   `MAVEN_CENTRAL_PASSWORD`; provision a release GPG key → secrets
   `MAVEN_GPG_PRIVATE_KEY`, `MAVEN_GPG_PASSPHRASE`. The parent POM will also
   need the Central publishing plugin + sources/javadoc/gpg plugins (Agent I /
   orchestrator change, outside `.github/` ownership).
4. **GitHub repo settings**: allow GitHub Actions to create and approve
   attestations (for `actions/attest-build-provenance`); optionally create a
   protected `release` environment with required reviewers and point the
   publish jobs at it when enabling them.
5. **Signing**: bot GPG key or gitsign for signed tags (above).
6. **Branch/tag protection**: protect `master` and `*/v*` tags so only the
   release workflow/owners can push tags.

## Rollback

Publishing is append-only almost everywhere; **prefer publishing a fixed
`x.y.z+1` over unpublishing**.

| Ecosystem | Rollback reality |
| --- | --- |
| npm | `npm unpublish` only within 72h and subject to policy; otherwise `npm deprecate @fireweaveai/sdk@<ver> "broken — use <ver+1>"` and repoint `latest`: `npm dist-tag add @fireweaveai/sdk@<good> latest`. |
| PyPI | Cannot re-upload a yanked version's file names. Use `yank` (pip stops selecting it by default) via the project UI/API, then release a fixed version. |
| Maven Central | Published artifacts are **immutable and cannot be removed**. Staged (not yet released) deployments can be dropped in the portal. Only fix-forward. |
| Go proxy | Cannot delete cached versions. Publish a fixed version, or in emergencies add a `retract` directive to `sdks/go/go.mod` and release it in the next tag — `go` tooling then warns on the retracted versions. |
| Git tags | If a bad tag was pushed but nothing published: delete the tag (`git push origin :refs/tags/<tag>`). If any registry consumed it, treat the version as burned; never re-use a version number. |

Always accompany a rollback with: a changelog entry in the next release, a
GitHub release note edit marking the version broken, and (npm/PyPI) a
deprecation/yank so resolvers steer clear.

## Local dry runs

Everything CI does at release-build time can be exercised locally:

```sh
scripts/build-all.sh                       # all package dry runs + SHA256SUMS
tools/release/changelog.sh node 0.1.0      # changelog preview to stdout
scripts/test-all.sh && scripts/conformance-all.sh   # full release gate
```
