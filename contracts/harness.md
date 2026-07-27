# Conformance Harness Contract

How each language SDK runs `contracts/` fixtures, compares results, and slots in OpenFeature Appendix B Gherkin.

## Goals

1. Prove Fireweave providers match fixture `expect` across Node, Python, Go, and Java.
2. Fail CI on silent divergence (see [`README.md`](./README.md)).
3. Reuse OpenFeature spec Appendix B `evaluation.feature` without flagd.

## Shared pipeline

```
discover fixtures → provision given → invoke when via real OF client
  → normalize actual → diff expect → emit compatibility row
```

Comparator library responsibilities (one per language, same rules):

- Drop excluded fields (timestamps, stacks, vendor `requestId`, nondeterministic metadata).
- Redact secrets in messages.
- Canonical-JSON serialize for structured `value` / `flagMetadata`.
- Enforce `compatibility` vs observed status matrix.

## Per-language runners

| Language | Runner entry (planned) | OF client setup | Backend for unit/contract | Backend for adapter I&T |
| --- | --- | --- | --- | --- |
| Node | `sdks/node/test/conformance/run.ts` (`vitest` or `node:test`) | `@openfeature/server-sdk` `setProviderAndWait` | In-memory adapter fed by fixture `given.flags` | `test-server` via injected `fetch` |
| Python | `sdks/python/tests/conformance/test_fixtures.py` (`pytest`) | `openfeature-sdk` `set_provider_and_wait` | In-memory adapter | `test-server` via `host=` override |
| Go | `sdks/go/conformance/harness_test.go` (`go test`) | `openfeature.SetProviderAndWait` | In-memory adapter | `test-server` via `Config.Transport` or `Endpoint` |
| Java | `sdks/java/src/test/java/.../ConformanceIT.java` (JUnit 5) | `OpenFeatureAPI.setProviderAndWait` | In-memory adapter | `test-server` via MockWebServer/`host` |

### Runner obligations

1. Load **all** `contracts/{evaluation,context,lifecycle,faults,security,extensions}/*.json`.
2. Skip only when fixture `compatibility.<lang> === "skipped-with-documented-limitation"` — record skip, do not execute assertions that would false-fail; optionally still execute and attach limitation if behavior is best-effort.
3. For `pass` fixtures, assert normalized equality with `expect`.
4. Write `compatibility-report.<lang>.json` (schema in README).
5. Exit non-zero on any `fail`.

### Lifecycle fixtures

Runners must drive real provider lifecycle (`initialize` / `onClose` / `shutdown` / `Close`) and read **client-visible** provider status from the SDK (not deprecated provider status fields).

### Extension fixtures

Invoke Fireweave extension APIs (releases / exposures / signals / capabilities) on the SDK surface documented by Agent D. Until that surface lands, runners MAY mark extension fixtures `skipped-with-documented-limitation` **only if** the fixture already declares that status for the language; do not invent skips.

## Comparator algorithm (normative)

```
normalize(actual):
  drop keys in EXCLUDE_SET (recursive)
  redact secret patterns in all strings
  if expect.errorMessagePrefix: keep only prefix check
  canonicalize numbers per flagType (integer fixtures require integral values)

compare(actual, expect):
  for each key in expect:
    if missing in actual → fail
    if object → deep compare
    else → strict equality
  extra keys in actual that are not excluded → fail (prevents silent metadata drift)
```

`EXCLUDE_SET` baseline: `timestamp`, `evaluatedAt`, `ts`, `createdAt`, `updatedAt`, `stack`, `stackTrace`, `requestId`, `uuid`, `traceId`, `spanId`, `messageId`, `latencyMs`, `durationMs`, `pid`, `hostname`.

## OpenFeature Appendix B Gherkin slot-in

Spec Appendix B (`specification/assets/gherkin/evaluation.feature`) runs against an **in-memory** provider without flagd.

### Integration plan

1. Vendor (or submodule) the upstream `evaluation.feature` at pinned OF spec **v0.8.0**.
2. Provide a Fireweave-backed in-memory adapter that satisfies the feature’s flag configuration steps (mirror official `InMemoryProvider` semantics for those scenarios).
3. Per-language cucumber runners:

| Language | Cucumber stack |
| --- | --- |
| Node | `@cucumber/cucumber` |
| Python | `pytest-bdd` or `behave` |
| Go | `godog` |
| Java | `cucumber-jvm` |

4. Tag mapping: `@fireweave-contracts` for our JSON suites; `@openfeature-appendix-b` for upstream Gherkin.
5. Do **not** adopt the flagd `test-harness` image for certification (decision brief §6 / Agent B §11).

### Oracle diff (optional CI job)

For each Appendix B scenario, run once against the language’s official in-memory provider and once against Fireweave+fake adapter; diff evaluation details after normalization. Mismatches are failures unless listed in an allowfile owned by contracts/.

## test-server role

Adapter integration tests point PostHog SDK hosts at `test-server` (see [`../test-server/README.md`](../test-server/README.md)). Contract unit tests should prefer the in-memory adapter for speed; use test-server for faults that require HTTP semantics (`delay`, `401`, `429`, `500`, `truncated`, invalid JSON).

## CI matrix (recommended)

```
languages: [node, python, go, java]
jobs:
  - contracts-json-fixtures
  - openfeature-appendix-b-gherkin
  - compatibility-report-aggregate  # fail if any fail; publish artifact
```

Aggregate step merges four reports and enforces: no missing fixture×language cells; no silent status drift vs fixture declarations.
