# Advanced: direct PostHog adapter (Python, Go)

> **Not the production default, and not available on Node.**
>
> - **Node:** removed in 2.1 — see [ADR-0006](adr/0006-node-drops-direct-posthog-adapter.md) and the [v2.0→2.1 migration](migration.md#from-fireweaveaisdk-v20-to-21-node). Use [`FireweaveRemoteAdapter`](remote.md).
> - **Python, Go:** still shipped, as an escape hatch for Fireweave-internal dogfood, migration, or when you explicitly want the app process to hold vendor keys.
> - **Java:** seam only, never production-ready — use `FireweaveRemoteAdapter`.
>
> Prefer [Fireweave remote](remote.md) (`FW_API_URL` / `FW_PROJECT_API_KEY`) everywhere. The
> direction of travel is that the other languages follow Node; treat this page as
> documentation of a shrinking surface, not a supported architecture.

The optional `PostHogAdapter` wraps the official PostHog server SDK (Python `posthog` 7.31.0, Go `posthog-go` v1.22.0) behind the vendor-neutral `BackendAdapter` boundary. Your application code never sees PostHog types on the Fireweave public API (ADR-0002).

## API key types

| Key prefix | What it is | Where it may live | Enables |
| --- | --- | --- | --- |
| `phc_…` | Project API key | Server config/env. Public-by-design at PostHog, but this SDK is server-only (ADR-0004) | Remote evaluation (`/flags?v=2`), event capture |
| `phs_…` | Feature-flags secure API key | **SECRET — server-side only, never in frontend bundles or client apps** | Local evaluation (definitions polling). Preferred secret key |
| `phx_…` | Personal API key | **SECRET — server-side only** | Local evaluation (legacy alternative to `phs_`) |

Rules the SDK enforces / expects:

- Prefer `phs_` over `phx_` for local evaluation.
- Supply a secret key **only** when you want local evaluation — its presence can start definitions polling.
- Keys are never logged; error messages redact `phc_`/`phs_`/`phx_` values and bearer tokens.
- Load keys from environment variables (e.g. `POSTHOG_PROJECT_API_KEY`), never hardcode them.

## Remote vs. local evaluation

| Mode | Keys | Behavior |
| --- | --- | --- |
| **Remote** (default) | `phc_` only | Each evaluation calls PostHog `/flags?v=2` through the vendor SDK. No poller. Network on the evaluation path (bounded by the flag-request timeout, default 3 s). |
| **Local** | `phc_` + `phs_`/`phx_` | Definitions are polled in the background and flags evaluate in-process. Flags that can't be computed locally fall back to `/flags` remotely. Readiness = first successful definitions load. |
| **Local-only** | same + only-evaluate-locally option | No `/flags` calls at evaluation time. Flags not computable locally resolve as absent → your default (`FLAG_NOT_FOUND`). |

Host defaults to PostHog US cloud (`https://us.i.posthog.com`); EU (`https://eu.i.posthog.com`) and self-hosted hosts are supported. Configured hosts must be `http(s)` and, when an allowlist is configured, on it (SSRF guard).

### Polling

Local-eval definitions polling targets a **30-second default interval** where the vendor SDK allows override (normalizing vendor defaults that differ — ADR-0002). Failed polls keep serving last-good definitions and move the runtime to `STALE` (decisions get reason `STALE` / `fireweave.fromCache` metadata) rather than failing evaluations. Hard auth/config failures during init are `FATAL`.

### Quota behavior

If your PostHog organization exceeds its feature-flag quota, `/flags?v=2` returns HTTP 200 with empty flags and `quotaLimited: ["feature_flags"]`. The SDK treats this as **flag-not-found, not an outage**: you get your default value, `errorCode = FLAG_NOT_FOUND`, and `flagMetadata["fireweave.quotaLimited"] = true`. Alert on that metadata key if you want to detect quota exhaustion.

## Per-language initialization

### Node

**Removed in 2.1.** `@fireweaveai/sdk/posthog` no longer resolves and `posthog-node` is no longer a peer dependency. Node applications use [`FireweaveRemoteAdapter`](remote.md); the one-line change is in the [v2.0→2.1 migration guide](migration.md#from-fireweaveaisdk-v20-to-21-node).

The Node SDK is now the reference for where the other languages are heading: zero runtime dependencies, no vendor name anywhere in the published build (enforced by `test/unit/no-vendor-leak.test.ts`), and one network adapter.

### Python

Requires the extra: `pip install 'fireweave[posthog]'`.

```python
from fireweave import FireweaveConfig, FireweaveRuntime, FireweaveClient
from fireweave.adapters.posthog import PostHogAdapter

config = FireweaveConfig(
    project_api_key=os.environ["POSTHOG_PROJECT_API_KEY"],   # phc_...
    host=os.environ.get("POSTHOG_HOST", "https://us.i.posthog.com"),
)
adapter = PostHogAdapter(config=config)
runtime = FireweaveRuntime(adapter, config=config)
runtime.initialize()
client = FireweaveClient(runtime)
```

### Go

```go
adapter, err := posthog.New(posthog.Config{
    ProjectAPIKey: os.Getenv("POSTHOG_PROJECT_API_KEY"),
    Endpoint:      "https://us.i.posthog.com",
})
```

### Java

`PostHogAdapter.create(config)` throws `UnsupportedCapability` until a Maven Central
PostHog server SDK exists. Prefer `FireweaveRemoteAdapter` for Java production.

## Test-server (PostHog protocol)

The repo stub also speaks PostHog paths for this advanced adapter:

```bash
node test-server/implementation/server.mjs
# POST /flags?v=2, GET /flags/definitions, POST /batch
```
