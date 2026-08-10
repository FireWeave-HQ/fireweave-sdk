# Public publish readiness checklist

Status as of 2026-07-27 (live checks from this machine).  
Goal: unblock **staging** publish of `0.1.0` without shipping broken claims (Java PostHog remains seam-only).

## Live status (verified)

| Gate | Status | Evidence |
| --- | --- | --- |
| License file | ✅ MIT already in repo | `LICENSE` — Copyright (c) 2026 Fireweave AI, Inc. |
| CI / dry-run packaging | ✅ | `scripts/build-all.sh`, `release.yml` dry-run path |
| Publish jobs | ✅ staging + PyPI production wired | TestPyPI via `release.yml` staging; real PyPI via `publish-python.yml` (tag `python/v*`) / `release.yml` production. npm `latest` + Maven still hard-disabled. |
| GitHub repo `FireWeave-HQ/fireweave-sdk` | ❌ **missing** | `gh repo view` → cannot resolve; local git has **no remote** |
| npm scope `@fireweaveai` | ✅ exists | `@fireweaveai/deploy-sdk@0.2.0` published |
| npm `@fireweaveai/sdk` | ✅ name free | registry 404 (ready to create on first publish) |
| PyPI `fireweave` / `fireweave-sdk` | ✅ both free (configure Trusted Publisher before first upload) | pypi.org + test.pypi.org 404 as of last check |
| Maven `ai.fireweave` | ❌ unclaimed | Maven Central search numFound=0 |
| Local `npm whoami` | ❌ not logged in | expected — use OIDC in CI, not local token |

## Decision log (company / you)

Ratified by release owner (niketh) 2026-07-27 — reply "yes" to publish-readiness proposal.

- [x] **D1. License ratification** — MIT (already in `LICENSE`).  
- [x] **D2. Repo visibility** — Public `FireWeave-HQ/fireweave-sdk`.  
- [x] **D3. npm package name** — `@fireweaveai/sdk`.  
- [x] **D4. PyPI name** — `fireweave`.  
- [x] **D5. Maven groupId** — `ai.fireweave` (Central verification still pending; Maven publish stays disabled).  
- [x] **D6. First publish channel** — Staging only (`npm` dist-tag `next`, TestPyPI, Go tag + proxy warm).  
- [x] **D7. Java PostHog honesty** — 0.1.0 ships seam-only / injection-only; no live `create(config)`.  
- [x] **D8. Explicit publish authorization** — Staging npm + TestPyPI + Go warm enabled when `dry_run=false` && `channel=staging`. Production + Maven remain `if: false`.

## Ordered unblock plan

### Phase A — Foundations (blocks everything else)

1. **Create and push the GitHub repo** (public under `FireWeave-HQ`).  
   - Suggested: `gh repo create FireWeave-HQ/fireweave-sdk --public --source=. --remote=origin --push`  
   - After push: enable Actions attestations; optionally add protected `release` environment with required reviewers.
2. **Ratify D1–D5** (license + names). No registry work without these.

### Phase B — Registry provisioning (manual UI + secrets)

3. **npm Trusted Publisher** (OIDC — same pattern as `publish-deploy-sdk.yml`):  
   - npmjs.com → org `@fireweaveai` → Trusted Publisher for package `@fireweaveai/sdk`  
   - Repository: `FireWeave-HQ/fireweave-sdk`  
   - Workflow: `release.yml`  
   - Environment: optional `release`  
   - Note: first publish of a *new* package may need a one-time granular token + 2FA; thereafter OIDC only.  
   - Must use **GitHub-hosted** runners for npm OIDC (already true in this repo’s workflows).
4. **PyPI + TestPyPI Trusted Publishers**:  
   - Create / pending-publish `fireweave` on PyPI and TestPyPI.  
   - Production PyPI trusted publisher: owner `FireWeave-HQ`, repo `fireweave-sdk`, workflow `publish-python.yml`, environment `release`.  
   - Also add `release.yml` + environment `release` if using the dispatch-based production path; TestPyPI needs `release.yml` for staging.
5. **Maven Central** (slowest):  
   - Verify namespace `ai.fireweave` at [Central Portal](https://central.sonatype.com/) (DNS TXT for `fireweave.ai`).  
   - Secrets: `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`, `MAVEN_GPG_PRIVATE_KEY`, `MAVEN_GPG_PASSPHRASE`.  
   - Code gap: parent POM still needs Central publishing + sources/javadoc/gpg plugins before `publish-maven` can succeed.
6. **Go**: no registry credentials — once the repo is **public**, pushing `sdks/go/v0.1.0` is enough for `proxy.golang.org`.

### Phase C — Enable staging publish (code change, needs D8)

7. In `.github/workflows/release.yml`, for **staging only**, change publish jobs from `if: false` to something like:
   ```yaml
   if: ${{ inputs.dry_run == false && inputs.channel == 'staging' && github.ref_protected /* or environment approval */ }}
   ```
   Keep **production** channel hard-disabled until a second authorization.
8. Dry-run on GitHub Actions: `workflow_dispatch` with `dry_run=true`.  
9. Staging publish: `dry_run=false`, `channel=staging`, `version=0.1.0` (or `0.1.0-rc.1`), one component at a time: **node → python → go → java**.

### Phase D — Production (later)

10. Second written authorization.  
11. Promote npm `next` → `latest`; re-upload PyPI; release Maven staging; tag final Go version.

## Recommended first ship set

| Component | Staging artifact | Caveat |
| --- | --- | --- |
| **node** | `@fireweaveai/sdk@0.1.0` dist-tag `next` | Highest value; PostHog real |
| **python** | TestPyPI `fireweave==0.1.0` | PostHog real |
| **go** | tag `sdks/go/v0.1.0-rc.1` | Needs public repo |
| **java** | Maven portal staging **or** delay | Document seam-only PostHog; consider delaying Central until namespace verified |

## What the agent can do for you (ask explicitly)

| Action | Needs your OK |
| --- | --- |
| Create `FireWeave-HQ/fireweave-sdk` + push `master` | Yes |
| Open a PR / commit that enables staging-only publish conditions | Yes (D8) |
| Add Maven Central plugins to the Java parent POM | Yes |
| Reserve PyPI/TestPyPI names via browser / API with your account | You (browser) |
| Configure npm/PyPI trusted publishers | You (browser) — agent can give exact field values |
| Run staging publish workflow | Yes after provisioning |

## Explicit non-goals until authorized

- Flipping production publish on  
- Publishing from a laptop with long-lived tokens (prefer CI OIDC)  
- Claiming Java live PostHog `create(config)` works  
- Claiming “bring your PostHog key” as the primary customer path (superseded by ADR-0005)

## Credential model correction (ADR-0005)

Customer apps must use a **Fireweave** key/secret. All evaluate/capture traffic goes to **fw-server**, which proxies to PostHog (or a future vendor). Do **not** document or require PostHog keys in the default quickstart.

**Blocking for a truthful staging publish of the remote path:**

1. fw-server routes: evaluate + capture (and later definitions) with Fireweave auth → PostHog forward  
2. SDK `FireweaveRemoteAdapter` in all four languages  
3. Docs/examples updated to `FW_*` credentials  

Until those land, staging packages should ship with **InMemory** + clear “remote adapter pending” notes — or wait to publish Node/Python until the remote adapter exists.

---

*Repo created 2026-07-27. Trusted publishers still need browser setup (see checklist above).*
