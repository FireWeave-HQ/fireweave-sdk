# Conformance Harness Contract

How each language SDK runs `contracts/` fixtures against the **v1 control-points surface**,
compares results, and reports into the cross-language compatibility matrix.

## Goals

1. Prove Fireweave's v1 control-points surface (`controlPoints.evaluate` / the nine typed
   methods / `invokeCapability`) matches fixture `expect` across Node, Python, Go, and Java.
2. Fail CI on silent divergence (see [`README.md`](./README.md)).
3. Report every language a fixture could conceivably apply to — 65 fixtures x 7 languages
   (node, web, python, java, go, rust, swift) — with an honest status for each cell, never a
   silently-missing one.

## Rewrite note (this document)

Earlier revisions of this file described the pipeline as *"invoke `when` via real OF
[OpenFeature] client"* and gave every runner an **OF-setup** column. ADR-0010 retired the
OpenFeature bridge from every language (no `FireweaveProvider`/`FireweaveWebProvider`,
no `dev.openfeature:sdk`/`@openfeature/*` dependency in any SDK's runtime path) in favor of
the two-capability v1 surface: control points and target registration
(`spec/control-points.md`). This document is rewritten to match — there is no OpenFeature
client left to invoke, and no OF-setup column to give a runner.

Fixtures and `spec/` survive unedited — `decision.schema.json` is Fireweave's own
(`$id: fireweave.ai/spec/…`), and only 1 of 76 fixture files (across contracts/ and
contracts/web/) ever named an OpenFeature package. `contracts/errors.md`/`errors.json`,
`contracts/README.md`, and everything under `contracts/web/` remain byte-untouched by this
rewrite; only this file's pipeline description changed.

## Shared pipeline

```
discover fixtures → provision given → invoke controlPoints (evaluate / invokeCapability)
  → normalize actual → diff expect → emit compatibility row
```

Construction is the real `BackendAdapter` + runtime + client stack for the target language —
never a mock of the client itself:

- **In-memory backend** (evaluation / context / lifecycle / security suites, and the one
  runnable extensions fixture): a deterministic, fixture-driven adapter (node/go/java:
  `InMemoryAdapter`; python: `InMemoryAdapter`) seeded from `given.flags`, wired directly into
  the language's runtime + client types (`FireweaveRuntime`/`Runtime` + `FireweaveClient`/
  `Client`). This is the "local mode" leg of the pipeline: the runner does not go through the
  `initFireweave`/`Fireweave.init`/`init_fireweave` entry point for these fixtures, because that
  entry point's local-mode adapter (`FireweaveLocalAdapter`) accepts only a
  `Record<string, boolean>` override map — it cannot carry the rich, multi-type, condition-
  matching flag definitions (variant, metadata, payload, matchAttribute/matchGroups/
  matchPerson, fault injection) the fixtures need. `initFireweave` itself (both modes) is
  exercised end-to-end by each language's own unit-test suite, which the language's `verify`/
  `test` command already runs alongside the conformance suite.
- **Remote backend** (faults suite): the real `FireweaveRemoteAdapter`/`Adapter` speaking
  `POST /v1/flags/evaluate` over real HTTP — this is the "remote mode" leg. The HTTP peer
  differs by language for environmental reasons (see "test-server role" below), but the
  adapter, the wire protocol, and the client invocation are all real; `fault-stale-cache`
  is the one faults-suite fixture that runs on the in-memory backend instead, since cache
  staleness is provisioned directly (`given.flags[*].fromCache` + `providerState: STALE`),
  not over HTTP.

Comparator library responsibilities (one per language, same rules):

- Drop excluded fields (timestamps, stacks, vendor `requestId`, nondeterministic metadata).
- Redact secrets in messages.
- Canonical-JSON serialize for structured `value` / `flagMetadata`.
- Enforce `compatibility` vs observed status matrix (extended vocabulary — see "Statuses" below).

## Per-language runners

| Language | Runner entry | Backend for evaluation/context/lifecycle/security | Backend for faults |
| --- | --- | --- | --- |
| Node | `sdks/node/test/conformance/run.ts` (`node:test` via `tsx`) | `InMemoryAdapter`, direct `FireweaveRuntime`+`FireweaveClient` | `FireweaveRemoteAdapter` vs the real `test-server` stub (`test-server/implementation/server.mjs`, spawned in-process) |
| Web | `sdks/web/test/conformance/run.ts` against **`contracts/web/`**, not this 65-fixture set (ADR-0009) | n/a — separate suite | n/a |
| Python | `sdks/python/conformance/runner.py` (+ `tests/test_conformance.py`, `pytest`) | `InMemoryAdapter`, direct `FireweaveRuntime`+`FireweaveClient` | `FireweaveRemoteAdapter` vs the real `test-server` stub (spawned subprocess) |
| Go | `sdks/go/internal/conformance` (+ `sdks/go/conformance/harness_test.go`, `go test`) | `InMemoryAdapter`, direct `Runtime`+`Client` | `Adapter` (remote) vs an **injected fake `http.RoundTripper`** — the canonical dockerized `golang:1.25-alpine` run has no `node` binary to spawn the real stub with; `FIREWEAVE_TEST_SERVER_URL` opts into the real stub for local iteration when `node` happens to be on `PATH` |
| Java | `sdks/java/fireweave-testing` (`ConformanceRunner` + `ConformanceTest`, `mvn test`) | `InMemoryAdapter`, direct `FireweaveRuntime`+`FireweaveClient` | `FireweaveRemoteAdapter` vs an **in-process HTTP stub** (`FixtureHttpStub`, pure JDK `com.sun.net.httpserver`) — same "no `node` in the canonical dockerized `maven:3.9-eclipse-temurin-21` image" constraint as Go, solved with a same-process embedded server instead of a fake transport |
| Rust | *(not implemented — Phase 6)* | — | — |
| Swift | *(not implemented — Phase 6)* | — | — |

Node and Python are close enough to a real subprocess `test-server` that they use it directly;
Go and Java's canonical CI environment cannot, so they substitute a same-language stand-in that
speaks the identical wire contract (`POST /v1/flags/evaluate`, `{decisions:[...], quotaLimited}`)
— this is a packaging-environment difference, not a behavioral one.

### Runner obligations

1. Load **all** `contracts/{evaluation,context,lifecycle,faults,security,extensions}/*.json`.
2. Apply the **v1-scope rule** (below) to extensions-suite fixtures before anything else.
3. Skip only when fixture `compatibility.<lang> === "skipped-with-documented-limitation"` —
   record skip, do not execute assertions that would false-fail.
4. For `pass` fixtures (post v1-scope filtering), assert normalized equality with `expect`.
5. Write `compatibility-report.<lang>.json` (schema in README, `language` field is the
   canonical lowercase name).
6. Exit non-zero on any `fail`.
7. Multi-case fixtures (`cases` array; see README): run every case against a fresh setup,
   shallow-merging `cases[].given` over fixture-level `given`; the fixture passes only when
   all cases pass. One report row per fixture (case detail in `message`).

The canonical inventory is **65** fixtures; each language's own report must contain 65 cells;
the cross-language aggregate (`tools/conformance/compare.mjs`) produces **65 x 7**.

### Lifecycle fixtures

Runners must drive real provider lifecycle (`initialize` / `shutdown` / `close`) and read
**client-visible** lifecycle state from the SDK (`FireweaveRuntime.getState()`/`.state()`/
`.State()`, not a deprecated provider-status field — there is no provider left).

### Extension fixtures — v1-scope rule (ruling 2, normative)

v1 narrows every SDK to two capabilities: control points and target registration
(`spec/control-points.md` "Scope of v1"). Releases, exposures, signals, and capabilities
discovery are cut entirely (ADR-0010) — `FireweaveClient`/`Client` exposes none of
`releases`/`exposures`/`signals`/`capabilities`/`guardrails`. The 14
`contracts/extensions/*.json` fixtures are frozen (byte-for-byte, per the plan's contracts/
protection) and were authored against the **pre-v1** surface those namespaces used to be —
running them unmodified against the v1 surface is not possible for 13 of the 14.

The rule a runner applies, **before** the ordinary skip/execute dispatch above:

> A fixture in `contracts/extensions/` whose `when.operation` (or, for a multi-case fixture,
> every `cases[].when.operation`) targets a cut namespace is reported per-cell as
> `skipped-v1-out-of-scope` — a status this document defines (see "Statuses" below) — and is
> **never executed**, regardless of the fixture's own declared `compatibility.<lang>` (frozen
> at `"pass"`, authored pre-cut). This is an intentional, ruled override of the frozen
> declaration, not a silent skip and not an undeclared divergence — `tools/conformance/
> compare.mjs` special-cases exactly this combination.
>
> **Exception:** a fixture that genuinely exercises v1 surface runs for real. Concretely, only
> `ext-unsupported-capability-degrade` qualifies: its operation is `invokeCapability`, which
> **is** present on the v1 client (not on the `mustNotExpose` list) and always degrades
> `UnsupportedCapability` — v1's `SUPPORTED_CAPABILITIES` is frozen empty, so any capability
> string produces exactly the `{ok: false, errorKind: UnsupportedCapability, degraded: true}`
> shape this fixture expects.

The full per-fixture classification (read individually, not inferred from the file name):

| Fixture | `when.operation` | Cut namespace | Classification |
| --- | --- | --- | --- |
| `ext-capabilities-get` | `getCapabilities` | capabilities | `skipped-v1-out-of-scope` |
| `ext-exposures-dedup` | `recordExposure` | exposures | `skipped-v1-out-of-scope` |
| `ext-exposures-flush` | `flushExposures` | exposures | `skipped-v1-out-of-scope` |
| `ext-exposures-record` | `recordExposure` | exposures | `skipped-v1-out-of-scope` |
| `ext-lifecycle-gating` | `emitSignal` (all 3 cases) | signals | `skipped-v1-out-of-scope` (see note) |
| `ext-releases-complete` | `complete` | releases | `skipped-v1-out-of-scope` |
| `ext-releases-fail` | `fail` | releases | `skipped-v1-out-of-scope` |
| `ext-releases-set-context` | `setContext` | releases | `skipped-v1-out-of-scope` |
| `ext-releases-start` | `start` | releases | `skipped-v1-out-of-scope` |
| `ext-signals-error` | `emitSignal` | signals | `skipped-v1-out-of-scope` |
| `ext-signals-health` | `emitSignal` | signals | `skipped-v1-out-of-scope` |
| `ext-signals-metric` | `emitSignal` | signals | `skipped-v1-out-of-scope` |
| `ext-signals-outcome` | `emitSignal` | signals | `skipped-v1-out-of-scope` |
| `ext-unsupported-capability-degrade` | `invokeCapability` | *(none — v1 surface)* | **runs for real** |

`ext-lifecycle-gating` note: its description ("Extension calls are lifecycle-gated... ruling
17") reads, on its surface, like the `invokeCapability` lifecycle-gate exception this rule
carves out — and every v1 client's `invokeCapability` implements an identical lifecycle gate
(`UnsupportedCapability` pre-READY, `AlreadyClosed` post-shutdown) for exactly this reason. But
its three cases all dispatch `emitSignal`, and the middle case ("ready-delivered-to-sink")
expects `{ok: true, accepted: true}` — an outcome `invokeCapability` can never produce, because
`SUPPORTED_CAPABILITIES` is frozen empty and the unsupported-capability check runs *before* the
lifecycle gate, in every language, regardless of state. Reproducing this fixture for real would
require the cut `signals` namespace, so it is classified with its `ext-signals-*` siblings, not
as the exception.

## Statuses (normative)

`contracts/README.md` defines the baseline three; this rewrite adds three more for the reasons
above. A per-language report's `status` field is one of:

| Status | Meaning |
| --- | --- |
| `pass` | Normalized actual output equals `expect`. |
| `fail` | Normalized actual output diverges from `expect`, or a declared-`pass`/-runnable fixture threw/panicked unexpectedly. |
| `skipped-with-documented-limitation` | Fixture declares this status for `compatibility.<lang>`, with a matching non-empty `limitations.<lang>` string. Unchanged from `contracts/README.md`. |
| `skipped-v1-out-of-scope` | **New.** The fixture (always in `contracts/extensions/`) targets a namespace cut from the v1 surface (ADR-0010); see the rule above. `limitation` names the cut namespace. |
| `not-applicable-web` | **New, aggregate-only.** Web's `contracts/web/` suite (ADR-0009) covers this instead; the shared 65 fixtures encode async server semantics a synchronous cache-read surface cannot answer. Never emitted by a per-language runner — only by `tools/conformance/compare.mjs`'s synthesized web column. |
| `not-implemented` | **New, aggregate-only.** No SDK exists yet for this language (rust/swift, Phase 6). Never emitted by a per-language runner — only by the aggregate's synthesized columns. |

A per-language runner (node/python/go/java) only ever emits the first four; the last two are
synthesized by the aggregate comparator for the three columns that have no runner to ask.

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

**Exception — `getCapabilities` (ruling 18):** N/A in v1 — `getCapabilities` is cut
(`skipped-v1-out-of-scope`, see above). This exception is retained here only as a pointer for
anyone consulting an older revision of this file or the git history: the structured
`{static, runtime}` matrix comparison it described no longer has a live fixture to apply to.

**Extra-key strictness note:** node/python/java's runners currently check only the keys
`expect` declares (they do not fail on an extra, undeclared key in `actual`); go's runner does
enforce the extra-key rule above literally, a difference that predates this rewrite and was not
changed by it. Tightening node/python/java to match is a legitimate future improvement, not
done here (out of this rewrite's scope — see task-10-report.md).

`EXCLUDE_SET` baseline: `timestamp`, `evaluatedAt`, `ts`, `createdAt`, `updatedAt`, `stack`,
`stackTrace`, `requestId`, `uuid`, `traceId`, `spanId`, `messageId`, `latencyMs`, `durationMs`,
`pid`, `hostname`.

## test-server role

`test-server/implementation/server.mjs` speaks the Fireweave-native remote protocol
(`POST /v1/flags/evaluate`, `POST /v1/targets/register`) plus its admin control plane
(`POST /_test/fault`, `/_test/flags`, `/_test/reset`). Node and Python spawn it directly (an
`npm`/`bun` and a `python` toolchain both have a `node` binary available, or install one, so
this is the norm). Go and Java's canonical CI containers
(`golang:1.25-alpine`, `maven:3.9-eclipse-temurin-21`) do not — see the per-language runner
table above for what each substitutes. All four still exercise the real `FireweaveRemoteAdapter`
/`Adapter` over real HTTP; only the process on the other end of the socket differs.

## Retired: OpenFeature Appendix B Gherkin slot-in

Earlier revisions of this document described vendoring the OpenFeature spec's Appendix B
`evaluation.feature` and running it per language via cucumber (`@cucumber/cucumber`,
`pytest-bdd`/`behave`, `godog`, `cucumber-jvm`), plus an "oracle diff" against each language's
official in-memory OpenFeature provider. ADR-0010 retired the OpenFeature bridge from every
language entirely (no provider, no `dev.openfeature:sdk`/`@openfeature/*` runtime dependency) —
there is no OpenFeature client left in any SDK to run Appendix B scenarios against, official or
otherwise, so this integration plan is retired along with it. `contracts/{evaluation,context,
lifecycle,faults,security,extensions}/*.json` are Fireweave's own fixture format and remain the
sole conformance source of truth.

## CI matrix (recommended)

```
languages: [node, python, go, java]        # real conformance runners
languages (synthesized, aggregate-only): [web, rust, swift]
jobs:
  - contracts-json-fixtures    # per-language: node/python/go/java each execute + report
  - compatibility-report-aggregate
      # tools/conformance/compare.mjs — merges the four real reports, synthesizes
      # web/rust/swift, enforces: no missing fixture x language cell, no silent status
      # drift vs fixture declarations (except the ruled v1-scope extensions carve-out),
      # fail on any "fail" row. Publishes build/conformance/{compatibility-report.json,
      # summary.md} — see scripts/conformance-all.sh.
```

Per-language `verify`/`test` commands (`npm run verify`, `uv run pytest`, `go test ./...`,
`mvn test`) are expected to pass green on their own — including their conformance entry — even
though the strict cross-language aggregate may still show real, documented, out-of-scope
divergences (see task-10-report.md "Concerns"): each language's test wrapper softens exactly
those known gaps (skip/xfail/assumption, never silently), while the report-writing CLI/`main()`
entry point and the aggregate comparator both report them honestly. A green per-language `verify`
is not the same claim as a clean aggregate — the aggregate is the stricter, cross-language gate.
