# Fireweave SDK Conformance Contracts

Canonical cross-language fixtures, error taxonomy, and harness contract for the Fireweave polyglot OpenFeature providers (`sdks/{node,python,go,java}`).

Language agents **consume** this tree; they must not edit it. Spec schemas live in `spec/` (Agent D) and are the **source of truth**; fixtures conform to spec. Context bounds were ratified by orchestrator arbitration (Phase 2 exit) — see the ratified limits table below.

## Layout

```
contracts/
  README.md                 # this file
  errors.md / errors.json   # Fireweave error taxonomy ↔ OpenFeature codes
  harness.md                # per-language runners, comparator, OF Gherkin slot-in
  evaluation/               # typed evaluation success & failure
  context/                  # targeting key, merge, identity, bounds
  lifecycle/                # init / shutdown / replace / domains
  faults/                   # transport, auth, quota, cache, offline
  security/                 # PII, secrets, SSRF, size/depth reject
  extensions/               # releases, exposures, signals, capabilities
```

## Fixture format

Each fixture is a single JSON file:

```json
{
  "schemaVersion": 1,
  "id": "eval-bool-success",
  "suite": "evaluation",
  "description": "Boolean flag resolves to true with TARGETING_MATCH",
  "tags": ["boolean", "success"],
  "provisional": false,
  "given": {
    "providerState": "READY",
    "flags": {
      "my-flag": {
        "type": "boolean",
        "enabled": true,
        "variant": "on",
        "value": true,
        "payload": null,
        "reason": { "code": "condition_match", "description": "Condition set 1 matched" },
        "metadata": { "version": 3 }
      }
    },
    "globalContext": {},
    "clientContext": {},
    "config": {}
  },
  "when": {
    "operation": "evaluate",
    "flagKey": "my-flag",
    "flagType": "boolean",
    "defaultValue": false,
    "invocationContext": {
      "targetingKey": "org_01HZXEXAMPLE000000000000"
    }
  },
  "expect": {
    "value": true,
    "variant": "on",
    "reason": "TARGETING_MATCH",
    "errorCode": null,
    "errorMessage": null,
    "flagMetadata": {
      "fireweave.flagVersion": 3
    }
  },
  "compatibility": {
    "node": "pass",
    "python": "pass",
    "go": "pass",
    "java": "pass"
  },
  "limitations": {}
}
```

### Field rules

| Field | Rules |
| --- | --- |
| `id` | Stable kebab-case; unique across all suites; matches filename without `.json` |
| `suite` | One of `evaluation`, `context`, `lifecycle`, `faults`, `security`, `extensions` |
| `given.providerState` | `NOT_READY` \| `READY` \| `ERROR` \| `STALE` \| `FATAL` \| `CLOSED` |
| `when.operation` | See operations table below |
| `when.flagType` | `boolean` \| `string` \| `integer` \| `float` \| `object` |
| `expect.errorCode` | OpenFeature code string or `null` (see `errors.md`) |
| `compatibility.<lang>` | `pass` \| `fail` \| `skipped-with-documented-limitation` |
| `limitations.<lang>` | Required when status is `skipped-with-documented-limitation`; free-text reason |
| `provisional` | `true` when the fixture depends on unratified `spec/` bounds (currently none — Phase 2 bounds are ratified) |

### Operations

| `operation` | Suite | Semantics |
| --- | --- | --- |
| `evaluate` | evaluation, context, faults, security | Typed flag evaluation |
| `initialize` | lifecycle | Provider init |
| `shutdown` | lifecycle | Provider shutdown |
| `replaceProvider` | lifecycle | Swap provider under a domain |
| `setContext` / `start` / `complete` / `fail` | extensions | Release lifecycle |
| `recordExposure` / `flushExposures` | extensions | Exposure telemetry |
| `emitSignal` | extensions | health / error / metric / outcome |
| `getCapabilities` | extensions | Capability discovery |
| `invokeCapability` | extensions | Call a named capability (may degrade) |

## Normalization (diff comparator)

Before comparing actual vs `expect`, harnesses **MUST** strip or rewrite nondeterministic fields. Divergence on normalized output is a CI failure.

### Always exclude from comparison

- Timestamps / wall-clock fields (`timestamp`, `evaluatedAt`, `ts`, `createdAt`, `updatedAt`, ISO-8601 datetimes)
- Stack traces (`stack`, `stackTrace`, `cause.stack`)
- Vendor request IDs (`requestId`, `X-Request-Id`, PostHog `requestId`)
- Nondeterministic metadata (`uuid`, `traceId`, `spanId`, `messageId`, generated ULIDs that are not fixture-declared)
- Transport timing (`latencyMs`, `durationMs`, `rtt`)
- Process/runtime noise (`pid`, `hostname`, `threadId`)

### Preserve (must match)

- Flag `value`, `variant`, `reason` (OpenFeature reason string)
- `errorCode` (OpenFeature code)
- Normalized `errorMessage` (see secrets rule)
- Declared `flagMetadata` keys that are fixture-stable (e.g. `fireweave.flagVersion`)
- Typed IDs present in the fixture itself (`stmp_*`, `chg_*`, `rolloutId`, `sfc_*`)

### Error message normalization

1. Redact secret-shaped substrings (`phc_…`, `phx_…`, `phs_…`, `FW_PROJECT_API_KEY` values, bearer tokens) → `[REDACTED]`.
2. Collapse whitespace runs to a single space; trim.
3. Do **not** require exact vendor phrasing beyond the fixture’s declared message (or message prefix when `expect.errorMessagePrefix` is set).

## Determinism rules

1. Fixtures contain **only** fixed literals — no “now”, random, or environment-dependent values.
2. Typed IDs use fixed Crockford ULID-ish strings with prefixes: `stmp_`, `chg_`, `sfc_`, and `rolloutId` values as plain strings in fixtures.
3. Sort object keys in harness serialization before hashing/diffing (canonical JSON).
4. Floating-point comparisons use exact JSON numbers as written; fixtures avoid values that require epsilon unless tagged `numeric-coercion`.
5. Context merge fixtures declare every layer explicitly; harnesses must not inject host identity.
6. Exposure dedup fixtures use fixed `(distinct_id, flag, value)` triples.
7. If a language cannot produce a bit-identical structured value (Node `number` vs int/float; Java long via double), mark `skipped-with-documented-limitation` — never silently coerce in the comparator.

## CI: fail on silent divergence

CI **MUST** fail when:

1. Actual normalized output ≠ `expect` for any language with `compatibility.<lang> = "pass"`.
2. A language reports `pass` in the compatibility report but the fixture file marks it `fail` or `skipped-with-documented-limitation` (or vice versa without an allowlisted update).
3. A fixture lacks a `compatibility` entry for any of `{node,python,go,java}`.
4. A `skipped-with-documented-limitation` entry lacks a non-empty `limitations.<lang>` string.
5. Two fixtures share the same `id`.
6. Comparator observes a non-normalized field that differs **and** that field was not on the exclude list — treat as harness bug (fail).

Silent skip of a `pass` fixture is forbidden. Skips require the documented-limitation status in both the fixture and the run report.

## How language harnesses consume fixtures

1. Discover `contracts/<suite>/*.json` (exclude `README` / non-JSON).
2. For each fixture, set up the in-memory / test-server backend from `given` (flags, state, fault mode).
3. Apply context layers in OpenFeature merge order: **global → transaction → client → invocation** (transaction optional; fixtures omit unless testing it).
4. Invoke `when.operation` through the **real** OpenFeature client + Fireweave provider (not a mock of the provider).
5. Capture evaluation details / lifecycle outcome / extension result.
6. Normalize per rules above; compare to `expect`.
7. Emit one row per `(fixture.id, language)` into the compatibility report.

Go harnesses must flatten context the same way the Go OF SDK does before asserting provider-boundary fixtures; evaluation fixtures assert **client-visible** details (post-SDK), so flattening is an implementation detail.

## Compatibility-report format

Harnesses write (or CI aggregates) a report:

```json
{
  "schemaVersion": 1,
  "generatedAt": "EXCLUDED",
  "sdkCommit": "optional",
  "contractsCommit": "optional",
  "results": [
    {
      "fixtureId": "eval-bool-success",
      "suite": "evaluation",
      "language": "node",
      "status": "pass",
      "limitation": null,
      "message": null
    },
    {
      "fixtureId": "eval-int-beyond-safe-integer",
      "suite": "evaluation",
      "language": "node",
      "status": "skipped-with-documented-limitation",
      "limitation": "Node OpenFeature exposes a single number resolver; integers beyond 2^53-1 are not lossless.",
      "message": null
    }
  ],
  "summary": {
    "pass": 0,
    "fail": 0,
    "skipped-with-documented-limitation": 0
  }
}
```

`status` is exactly one of: `pass` | `fail` | `skipped-with-documented-limitation`.

CI gate: `fail == 0`. Skips are allowed only when the fixture declares the same status + limitation text (semantic match; harness may copy fixture limitation verbatim).

## Ratified context limits

Canonical bounds ratified by orchestrator arbitration (Phase 2 exit, 2026-07-27), matching `spec/evaluation-context.schema.json`:

| Limit | Canonical value |
| --- | --- |
| Max attribute count (context) | **128** |
| Max key size (UTF-8 bytes) | **256** |
| Max value size (UTF-8 bytes / serialized scalar) | **4 KiB** (4096) |
| Max nesting depth | **6** |
| Max serialized evaluation context | **64 KiB** (65536) |

Oversized / over-deep inputs must yield `InvalidContext` (OF `INVALID_CONTEXT`) and the **default value**, never a throw from the client evaluation API.

## Related docs

- Error taxonomy: [`errors.md`](./errors.md) / [`errors.json`](./errors.json)
- Harness runners: [`harness.md`](./harness.md)
- Local PostHog protocol stub: [`../test-server/README.md`](../test-server/README.md)
- Phase 1 decisions: [`../docs/orchestration/decision-brief.md`](../docs/orchestration/decision-brief.md)
