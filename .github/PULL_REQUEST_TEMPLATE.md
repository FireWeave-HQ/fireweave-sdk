<!-- Thanks! Please read CONTRIBUTING.md before opening the PR. -->

## What & why

<!-- Summary of the change and the problem it solves. Link issues: Fixes #123 -->

## Scope

<!-- Which parts does this touch? -->
- [ ] Node (`sdks/node`)
- [ ] Python (`sdks/python`)
- [ ] Go (`sdks/go`)
- [ ] Java (`sdks/java`)
- [ ] spec / contracts (**orchestrated review required** — see CONTRIBUTING.md)
- [ ] test-server / examples / docs / CI

## Checklist

- [ ] **DCO**: every commit is signed off (`git commit -s`; `Signed-off-by:` matches the author). *This is a hard requirement — no CLA, but no unsigned commits.*
- [ ] **Tests**: unit tests pass for every language touched, and new behavior is covered by tests.
- [ ] **Conformance**: the `contracts/` suite passes for every language touched (`npm run conformance` / `pytest` + `run_conformance.py` / `go run ./cmd/conformance` / `mvn install`). Any new skip uses `skipped-with-documented-limitation` in the fixture itself.
- [ ] **Cross-language parity**: public-API/behavior changes either land for all four languages or the PR description states the parity plan.
- [ ] **No secrets**: no real API keys (`phc_`/`phs_`/`phx_`), tokens, or PII in code, tests, fixtures, or error messages.
- [ ] **No vendor types** leaked into any public API surface.
- [ ] **Docs**: user-visible changes are reflected in `docs/` (and `CHANGELOG.md` under *Unreleased*).

## Verification

<!-- Paste the test/conformance commands you ran and their results. -->
