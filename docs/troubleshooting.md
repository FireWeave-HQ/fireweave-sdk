# Troubleshooting

First diagnostic step, always: read the **details** of a failing evaluation, not just the value. `errorCode`, `reason`, and `controlPointMetadata['fireweave.errorKind']` name the failure precisely ([concepts.md](concepts.md#error-taxonomy)).

## "I always get the default value"

Work through the checklist — every cause has a distinct signature:

| `errorCode` / signature | Cause | Fix |
| --- | --- | --- |
| `PROVIDER_NOT_READY`, `fireweave.errorKind: NotReady` | Evaluating before init finished | Initialise before evaluating: use the client your SDK's init entry point returns (Node: `await initFireweave(...)`), or await `runtime.initialize()` when wiring the runtime yourself |
| `PROVIDER_NOT_READY`, `fireweave.errorKind: AlreadyClosed` | Evaluating after shutdown | Fix lifecycle ordering; a shut-down runtime is terminal — construct a new one |
| `FLAG_NOT_FOUND` | Flag key doesn't exist in the backend (typo, wrong project, not in the in-memory fixture, or the test-server stub's own fixtures) | Verify key + project; against the stub, `POST /_test/flags` your flags |
| `FLAG_NOT_FOUND` + `fireweave.quotaLimited: true` | Backend control-point quota exceeded — HTTP 200 with no decisions | Address quota/billing on your Fireweave project; deliberately not treated as an outage |
| `TYPE_MISMATCH` | Flag's stored type ≠ getter type (string flag via boolean getter) | Use the matching typed getter |
| `TARGETING_KEY_MISSING` | No `targetingKey` in context (required for backend evaluation) | Supply a stable key ([identity.md](identity.md)) |
| `INVALID_CONTEXT` | Context bounds exceeded (128 attrs / 256 B keys / 4 KiB values / depth 6 / 64 KiB total) or reserved-key misuse (`fireweave.*`, `kind`) | Slim the context; rename reserved-colliding attributes |
| `GENERAL` + errorKind `Authentication`/`Authorization` | Wrong/revoked key, or key from a different project | Check env vars; messages are redacted by design, so compare key *prefixes* and project settings |
| `GENERAL` + errorKind `Timeout`/`Network`/`BackendUnavailable` | Transport problem on the evaluation path (remote mode) | Check host/egress |
| `PROVIDER_FATAL` / errorKind `Configuration` | Invalid host URL, host not on the SSRF allowlist, non-positive timeout/limit values, missing required key | Fix config; this state is not retried |
| No error, `reason: DISABLED` | Flag exists and is switched off | Expected: you get the default/off value |
| No error, value just "wrong" | Targeting didn't match (missing person properties, non-sticky targeting key) | Compare context attributes against the flag's conditions; verify the targeting key is stable |

## "Values are stale after I changed a flag"

- `reason: STALE` anywhere means last-good data during backend degradation — check connectivity and fw-server health; recovery is automatic.

## "It hangs on shutdown" / "my process won't exit"

Shutdown is deadline-bounded (default 10 s) — a hang longer than that means shutdown was never called (check your signal handling) or something outside Fireweave holds the loop open.

## Debugging without a backend account

Reproduce against the deterministic stub with scripted faults (401/429/500/delay/invalid JSON/quota) — [testing.md](testing.md#the-protocol-test-server). If you can reproduce a bug there or on the `InMemoryAdapter`, attach that reproduction to your [bug report](../.github/ISSUE_TEMPLATE/) — it's the fastest route to a fix.

## Still stuck

See [SUPPORT.md](../SUPPORT.md). Include: language + SDK version, runtime (Node / Bun / Deno + version), adapter and mode (in-memory / Fireweave remote), the full evaluation details (value, reason, errorCode, controlPointMetadata), and runtime state at the time (`runtime.getState()` / `runtime.state()` / `runtime.State()`).
