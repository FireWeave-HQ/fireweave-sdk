# Troubleshooting

First diagnostic step, always: read the **details** of a failing evaluation, not just the value. `errorCode`, `reason`, and `flagMetadata['fireweave.errorKind']` name the failure precisely ([concepts.md](concepts.md#error-taxonomy)).

```js
const d = await client.getBooleanDetails('my-flag', false, ctx);
console.log(d.reason, d.errorCode, d.errorMessage, d.flagMetadata);
```

## "I always get the default value"

Work through the checklist — every cause has a distinct signature:

| `errorCode` / signature | Cause | Fix |
| --- | --- | --- |
| `PROVIDER_NOT_READY`, `fireweave.errorKind: NotReady` | Evaluating before init finished (Node default `lazyReady: true` returns immediately!) | Use `setProviderAndWait` (Node: with `lazyReady: false`), or wait for the READY event ([lifecycle.md](lifecycle.md)) |
| `PROVIDER_NOT_READY`, `fireweave.errorKind: AlreadyClosed` | Evaluating after shutdown | Fix lifecycle ordering; a shut-down runtime is terminal — construct a new one |
| `FLAG_NOT_FOUND` | Flag key doesn't exist in the backend (typo, wrong project, not in the in-memory fixture, or the test-server stub's own fixtures) | Verify key + project; against the stub, `POST /_test/flags` your flags |
| `FLAG_NOT_FOUND` + `fireweave.quotaLimited: true` | Backend control-point quota exceeded — HTTP 200 with no decisions | Address quota/billing on your Fireweave project; deliberately not treated as an outage |
| `TYPE_MISMATCH` | Flag's stored type ≠ getter type (string flag via boolean getter; Java: integral value outside 32-bit `int` range) | Use the matching typed getter; Java large integers → `getDoubleValue` or object flags ([compatibility.md](compatibility.md)) |
| `TARGETING_KEY_MISSING` | No `targetingKey` in context (required for backend evaluation) | Supply a stable key ([identity.md](identity.md)) |
| `INVALID_CONTEXT` | Context bounds exceeded (128 attrs / 256 B keys / 4 KiB values / depth 6 / 64 KiB total) or reserved-key misuse (`fireweave.*`, `kind`) | Slim the context; rename reserved-colliding attributes |
| `GENERAL` + errorKind `Authentication`/`Authorization` | Wrong/revoked `phc_`/`phs_` key, or key from a different project | Check env vars; messages are redacted by design, so compare key *prefixes* and project settings |
| `GENERAL` + errorKind `Timeout`/`Network`/`BackendUnavailable` | Transport problem on the evaluation path (remote mode) | Check host/egress; consider local evaluation to take the network off the hot path |
| `PROVIDER_FATAL` / errorKind `Configuration` | Invalid host URL, host not on the SSRF allowlist, non-positive timeout/limit values, missing required key | Fix config; this state is not retried |
| No error, `reason: DISABLED` | Flag exists and is switched off | Expected: you get the default/off value |
| No error, value just "wrong" | Targeting didn't match (missing person properties, non-sticky targeting key) | Compare context attributes against the flag's conditions; verify the targeting key is stable |

## "Values are stale after I changed a flag"

- **Local evaluation** polls definitions (default 30 s) — changes are not instant.
- **Java remote mode [PostHog-specific]**: the vendor SDK caches per-user remote results up to ~5 minutes; stale serves are labeled (`reason: STALE`, `fireweave.fromCache: true`) rather than hidden.
- `reason: STALE` anywhere means last-good data during backend degradation — check connectivity and fw-server health; recovery is automatic.
- **Node (v3)** has no in-process cache: every evaluation is a fw-server round trip, so "stale" can only originate upstream. `localEvaluation` is `false` in `capabilities.get()` ([ADR-0006](adr/0006-node-drops-direct-posthog-adapter.md)).

## "It hangs on shutdown" / "my process won't exit"

Shutdown is deadline-bounded (default 10 s) — a hang longer than that means shutdown was never called (check your signal handling) or something outside Fireweave holds the loop open. Go: pass a deadline via `of.ShutdownWithContext(ctx)` / `CloseTimeout`. Also note injected vendor clients are *your* responsibility to close — Fireweave deliberately won't.

## "Exposure events aren't showing up"

1. Check the policy: evaluation is side-effect-free by default. Opt in per call with `sendExposure: true`, or record explicitly. Go additionally requires `SendExposureEvents: true` ([extensions.md](extensions.md#exposures)).
2. Explicit exposures sit in an in-process queue until `exposures.flush()` — and are **deduplicated** per `(targetingKey, flagKey, variant, value)`, so a second identical record is acknowledged (`deduped: true`) but not re-sent.
3. Go/Java: flush before shutdown; the native shutdown path won't flush the extension queue for you.

## "UnsupportedCapability"

Expected in exactly two places phase-one: **guardrails** (typed stub, everywhere) and **Java `PostHogAdapter.create(config)`** (upstream PostHog Java server SDK not yet published — inject a `PostHogClientApi` instead; [posthog.md](posthog.md#java)). Anywhere else, check the capability name against `capabilities.get` ([extensions.md](extensions.md#capabilities)).

## Language-specific gotchas

- **Node**: the SDK is ESM (`type: module`) with zero runtime dependencies and one peer (`@openfeature/server-sdk`). `@fireweaveai/sdk/posthog` was removed in 2.1 — a `Cannot find module` on that subpath means you are on v2.0 code with a 2.1 package ([migration](migration.md#from-fireweaveaisdk-v20-to-21-node)). Integers beyond 2^53−1 are not lossless (single `number` resolver). On Deno, reading `FW_API_URL`/`FW_PROJECT_API_KEY` from the environment needs `--allow-env`; passing them explicitly needs no env permission ([runtimes.md](runtimes.md)).
- **Python**: OpenFeature support needs the `fireweave[openfeature]` extra; the PostHog adapter needs `fireweave[posthog]`. The OpenFeature 0.10.x client short-circuits NOT_READY/FATAL providers with a generic error — the Fireweave provider deliberately absorbs post-FATAL state into default-valued decisions so you keep the precise taxonomy.
- **Go**: extension APIs take a `context.Context` and return `error` — a non-nil error from `Releases().Start` etc. with a mismatched `rolloutId` means the bound release context doesn't match ([extensions.md](extensions.md#releases)).
- **Java**: SLF4J "no providers" warnings from the OpenFeature SDK are cosmetic — add an SLF4J binding to silence them. `getIntegerValue` is 32-bit; out-of-range integral flags resolve `TYPE_MISMATCH` by design.

## Debugging without a backend account

Reproduce against the deterministic stub with scripted faults (401/429/500/delay/invalid JSON/quota) — [testing.md](testing.md#the-protocol-test-server). If you can reproduce a bug there or on the `InMemoryAdapter`, attach that reproduction to your [bug report](../.github/ISSUE_TEMPLATE/) — it's the fastest route to a fix.

## Still stuck

See [SUPPORT.md](../SUPPORT.md). Include: language + SDK version, runtime (Node / Bun / Deno + version), adapter and mode (in-memory / Fireweave remote / direct vendor), the full evaluation details (value, reason, errorCode, flagMetadata), and runtime state at the time (`runtime.getState()` / `runtime.state()` / `runtime.State()`).
