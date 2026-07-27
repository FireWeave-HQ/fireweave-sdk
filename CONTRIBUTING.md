# Contributing to the Fireweave SDK

Thanks for your interest. This document covers the sign-off requirement, how to build and test each language SDK, and the rules that keep the four implementations behaviorally identical.

Also read the [Code of Conduct](CODE_OF_CONDUCT.md) and [GOVERNANCE.md](GOVERNANCE.md).

## Developer Certificate of Origin (DCO) — not a CLA

We use the [Developer Certificate of Origin 1.1](https://developercertificate.org/). There is **no Contributor License Agreement**. By signing off you certify that you have the right to submit the contribution under the repository's license.

Every commit must carry a `Signed-off-by` line matching the commit author:

```
Signed-off-by: Your Name <you@example.com>
```

Add it automatically with:

```bash
git commit -s
```

If you forgot on the last commit: `git commit --amend -s --no-edit`. For a whole branch: `git rebase --signoff main`. Pull requests with unsigned commits will not be merged.

## Before you start

- **Bugs / small fixes**: open an issue first if the fix changes observable behavior; otherwise a PR is fine.
- **Features / API changes**: open an issue for discussion first. Public-API changes must keep the four languages consistent (see [GOVERNANCE.md](GOVERNANCE.md) for the ADR process) — a feature landing in one language needs a plan for the other three.
- **Cross-cutting design changes** require an ADR under `docs/adr/`.

## Build & test per language

All four SDKs must pass their unit tests **and** the shared conformance suite (`contracts/`) before a PR is mergeable.

### Node (`sdks/node`, Node ≥ 20.20)

```bash
cd sdks/node
npm install
npm run verify          # typecheck + unit + integration + conformance
# individually:
npm run build
npm run test:unit
npm run test:integration
npm run conformance
```

### Python (`sdks/python`, Python ≥ 3.10)

```bash
cd sdks/python
python -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/pytest                                   # unit + conformance tests
.venv/bin/python conformance/run_conformance.py    # compatibility report JSON
```

### Go (`sdks/go`, Go 1.25)

```bash
cd sdks/go
go build ./... && go vet ./... && go test -race ./...
go run ./cmd/conformance -contracts ../../contracts -out compatibility-report.go.json
```

### Java (`sdks/java`, JDK 11+, Maven)

```bash
cd sdks/java
mvn install                           # build + unit tests + JUnit conformance run
mvn -pl fireweave-testing exec:java   # standalone conformance runner
```

### Examples

Every example runs offline (in-memory adapter) and must keep working:

```bash
node examples/node/index.mjs
.venv/bin/python examples/python/service.py
(cd examples/go && go run .)
(cd examples/java && mvn -q compile exec:java)
```

## Contract-fixture and schema change policy

`spec/*.schema.json` and `contracts/**` are the **canonical cross-language contract**. They are deliberately hard to change:

- `spec/` schemas are the source of truth; fixtures in `contracts/` conform to spec.
- **Canonical fixture or schema changes land only through orchestrated review**: propose the change in an issue, get maintainer sign-off for all four languages, and land the spec/fixture change together with (or before) the implementation changes. Never edit a fixture to make one language's tests pass.
- A fixture skip requires `skipped-with-documented-limitation` status **in the fixture** plus a non-empty `limitations.<lang>` reason. Silent skips are a CI failure (see `contracts/README.md`).
- Language SDK code must not depend on fixture internals beyond the documented harness contract (`contracts/harness.md`).

## Pull request checklist

- [ ] All commits signed off (DCO).
- [ ] Unit tests + conformance pass for every language you touched.
- [ ] New behavior is covered by tests (and by a contract fixture if it is cross-language behavior).
- [ ] No secrets in code, tests, fixtures, or error messages (`phc_`/`phs_`/`phx_` keys, bearer tokens — see `contracts/errors.md` redaction rules).
- [ ] Public API changes: docs updated (`docs/`), and parity plan for the other languages stated in the PR description.
- [ ] No PostHog (or other vendor) types in any public API surface.

## Commit style

Conventional-commit-ish subjects are appreciated (`feat(go): …`, `fix(python): …`, `docs: …`) but not enforced. Keep subjects under ~72 characters and explain *why* in the body when it isn't obvious.

## Security issues

Do **not** open public issues for vulnerabilities — see [SECURITY.md](SECURITY.md).
