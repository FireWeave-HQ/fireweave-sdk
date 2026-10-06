# Control Points — normative surface

- **Status:** Normative for SDK v1
- **Applies to:** every language SDK in `sdks/`
- **Validated by:** `conformance/surface/` (surface parity)

A **control point** is a named decision the product can change without a deploy. This
document fixes the surface every SDK exposes for reading one. It says nothing about how a
decision is produced — that is `remote-protocol.md` and the adapter's business.

## Scope of v1

Exactly two capabilities: **control points** (this document) and **target registration**
(`remote-register-target.schema.json`). Releases, exposures, signals, capabilities discovery and guardrails
are out of v1. An SDK MUST NOT expose them, and MUST NOT expose an OpenFeature provider.

## The namespace

Every SDK exposes the surface under a namespace named `controlPoints`, cased for the
language: `controlPoints` (TS, Java, Swift, Dart), `control_points` (Python, Rust),
`ControlPoints` (Go).

There is no `flags` alias: 3.0.0 removed it (ADR-0013).

## The nine methods

| Method | Returns | Notes |
| --- | --- | --- |
| `getBooleanValue(key, default, context?)` | `boolean` | |
| `getStringValue(key, default, context?)` | `string` | |
| `getNumberValue(key, default, context?)` | `number` | **`number`**, not `integer` — `Decision.value` is `jsonValue` |
| `getObjectValue(key, default, context?)` | `json` | REQUIRED, not optional |
| `getBooleanDetails(key, default, context?)` | `Decision` | |
| `getStringDetails(key, default, context?)` | `Decision` | |
| `getNumberDetails(key, default, context?)` | `Decision` | |
| `getObjectDetails(key, default, context?)` | `Decision` | |
| `evaluate(key, type, default, context?, options?)` | `Decision` | the general form the eight delegate to |

`*Value` returns `Decision.value`. `*Details` returns the whole `Decision`
(`decision.schema.json`). Both take the same arguments, so a caller upgrades from one to the
other without restructuring the call.

Naming follows each language's idiom (`get_boolean_value`, `GetBooleanValue`) but the
**method set and its semantics do not vary**. A language missing any of the nine fails
`conformance/surface/`.

The wire and the envelopes name the key `controlPointKey`, and its metadata
`controlPointMetadata` (ADR-0013, superseding ADR-0007's `flagKey` boundary). OpenFeature's own
vocabulary (`FLAG_NOT_FOUND`) appears only in the error mapping column.

## Return discipline — never throw into a read path

A control-point read MUST NOT raise into the caller. Every failure resolves to the caller's
`default` with a `Decision` naming the reason:

| Situation | `value` | `reason` | `error.kind` |
| --- | --- | --- | --- |
| decision served | resolved | `TARGETING_MATCH` \| `SPLIT` \| `STATIC` \| `CACHED` | — |
| key unknown to the backend | `default` | `ERROR` | `ControlPointNotFound` |
| resolved value is the wrong type | `default` | `ERROR` | `TypeMismatch` |
| `default` does not match `type` | `default` | `ERROR` | `TypeMismatch` |
| context fails validation | `default` | `ERROR` | `InvalidContext` |
| runtime not initialised | `default` | `ERROR` | `NotReady` |
| runtime closed | `default` | `ERROR` | `AlreadyClosed` |
| backend unreachable / slow, no earlier successful fetch | `default` | `ERROR` | `Network` \| `Timeout` \| `BackendUnavailable` |
| a re-fetch fails after an earlier success (prefetching SDKs) | last good value | `STALE` | — |
| prefetch ceiling lost the race (web) | `default` | `STALE` | — |

Error kinds are the 15 in `errors.schema.json`. `STALE` is a `reason`, not an error: the
runtime is serving a usable-but-not-fresh cache, which is a different claim from failure and
MUST stay distinguishable.

**A failed re-fetch keeps the last good decisions.** SDKs that read from a prefetched cache
(web, Swift, Dart) MUST NOT discard it when a later fetch fails: after at least one successful
fetch, a failed or timed-out re-fetch keeps the cached decisions and serves them with reason
`STALE`, and the next successful fetch replaces them. Switching every read to its default on one
429, 5xx or network blip would roll every user back at once; that is a worse outcome than
serving decisions that are a little old, and it is exactly what `STALE` exists to report. Only
a fetch with no earlier success falls back to defaults with `ERROR`.

**Why a return rather than an exception.** These calls sit in request and render paths. If
they raise, every call site needs a guard and fail-open becomes a convention instead of a
type. Returning the decision makes "degrade to the caller's default" the only expressible
outcome, and it ports to `Result` / `(T, error)` without pretending exceptions are universal.

`initialise` (see `modes.md`) is the exception: bad configuration MUST fail loudly at boot.

## Validation, before any I/O

Implementations MUST validate in this order and stop at the first failure, returning the
default with the kind above:

1. **key** — non-empty, ≤256 characters, no control characters
2. **default vs type** — `getBooleanValue` with a non-boolean default is `TypeMismatch`
3. **context** — depth, key count, value size, reserved keys (`evaluation-context.schema.json`)
4. **lifecycle** — not `NotReady`, not `AlreadyClosed`

Validation MUST be reachable without a backend, so `conformance/` can assert it offline.

## Context

`context` is per-invocation and merges over any context already set on the runtime, later
winning. Merge order and limits are fixed by `evaluation-context.schema.json`.

`targetingKey` is what a percentage ramp buckets on. An SDK MUST NOT invent one: a missing
targeting key is `InvalidContext` where the evaluation needs it, never a generated
anonymous id. A constant targeting key hashes every caller into one bucket, which makes a
percentage ramp meaningless while looking healthy — so it must be the caller's decision,
visibly.

## Side effects

A v1 read is side-effect free. Exposure recording is out of scope, so no read emits
telemetry as a consequence of being called.
