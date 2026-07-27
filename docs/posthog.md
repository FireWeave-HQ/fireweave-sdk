# PostHog-backed usage

Phase one evaluates flags through PostHog **[PostHog-specific]**. The `PostHogAdapter` in each language wraps the official PostHog server SDK (Node `posthog-node` 5.46.1, Python `posthog` 7.31.0, Go `posthog-go` v1.22.0; Java — see [caveat](#java)) behind the vendor-neutral `BackendAdapter` boundary. Your application code never sees PostHog types, and the SDK never reimplements PostHog's flag evaluator (ADR-0002).

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

`PostHogAdapter` lives behind the `@fireweaveai/sdk/posthog` subpath (so the main entrypoint has no `posthog-node` dependency; `posthog-node` is an optional peer dependency you install yourself).

```js
import { OpenFeature } from '@openfeature/server-sdk';
import { FireweaveProvider, FireweaveRuntime } from '@fireweaveai/sdk';
import { PostHogAdapter } from '@fireweaveai/sdk/posthog';

const adapter = new PostHogAdapter({
  projectApiKey: process.env.POSTHOG_PROJECT_API_KEY,   // phc_...
  host: process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com',
  // Local evaluation (optional; server-side secret):
  // secretApiKey: process.env.POSTHOG_FF_SECRET_KEY,   // phs_/phx_
  // onlyEvaluateLocally: true,
  // waitForLocalDefinitions: true,                     // block init on first poll
  featureFlagsRequestTimeoutMs: 3000,
  // featureFlagsPollingInterval: 30_000,
});
const runtime = new FireweaveRuntime(adapter, {
  projectApiKey: process.env.POSTHOG_PROJECT_API_KEY,
  host: process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com',
  // allowedHosts: ['us.i.posthog.com'],                // SSRF allowlist
});
await OpenFeature.setProviderAndWait(new FireweaveProvider(runtime, { lazyReady: false }));
```

Advanced: pass `client:` to inject an existing `posthog-node` client (structural interface, no vendor types); injected clients are never shut down by Fireweave.

Exposure policy: the Node adapter reads snapshots side-effect-free (vendor-side `$feature_flag_called` is disabled); exposures flow through the explicit [exposures API](extensions.md#exposures).

### Python

Requires the extra: `pip install 'fireweave[posthog]'`.

```python
from fireweave import FireweaveConfig, FireweaveRuntime, FireweaveClient
from fireweave.adapters.posthog import PostHogAdapter

config = FireweaveConfig(
    project_api_key=os.environ["POSTHOG_PROJECT_API_KEY"],   # phc_...
    host=os.environ.get("POSTHOG_HOST", "https://us.i.posthog.com"),
    # Local evaluation (optional; server-side secret):
    # secret_key=os.environ["POSTHOG_FF_SECRET_KEY"],        # phs_ (or personal_api_key=phx_)
    # local_evaluation=True,
    # only_evaluate_locally=True,
    # allowed_hosts=("us.i.posthog.com",),                   # SSRF allowlist
)
runtime = FireweaveRuntime(PostHogAdapter(config=config), config)
runtime.initialize(backend_required=True)   # fail fast (FATAL) on bad config
client = FireweaveClient(runtime)
```

Advanced: `PostHogAdapter(client=...)` injects a preconfigured `posthog.Posthog` (never shut down by Fireweave); `transport=` overrides the snapshot fetcher for fault testing.

### Go

```go
import (
    "github.com/FireWeave-HQ/fireweave-sdk/sdks/go/adapters/posthog"
    "github.com/FireWeave-HQ/fireweave-sdk/sdks/go/fireweave"
)

adapter := posthog.New(posthog.Config{
    ProjectAPIKey:      os.Getenv("POSTHOG_PROJECT_API_KEY"), // phc_... (required)
    Endpoint:           "https://us.i.posthog.com",           // required
    SecretKey:          os.Getenv("POSTHOG_FF_SECRET_KEY"),   // optional: enables local eval
    // LocalEvaluationOnly: true,                             // requires SecretKey
    FlagRequestTimeout: 3 * time.Second,
    // FlagRequestRetries: 0,                                 // default: surface typed error
    // SendExposureEvents: true,                              // vendor $feature_flag_called (default false)
    CloseTimeout:       5 * time.Second,                      // bound on shutdown
    // AllowedHosts:    []string{"us.i.posthog.com"},         // SSRF allowlist override
})
runtime := fireweave.NewRuntime(adapter, fireweave.Config{RequireTargetingKey: true})
```

Config is validated during `Initialize` so failures map to the runtime's `FATAL` state. `Close` never inherits posthog-go's indefinite-wait default — it is always deadline-bounded.

### Java

> **Upstream caveat (orchestrator ruling 10):** `com.posthog:posthog-server` — the pinned Java server SDK — **is not published on Maven Central** (verified 2026-07-27; only the Android artifact and the prohibited legacy `com.posthog.java:posthog` 1.2.0 exist). The Java `PostHogAdapter` is complete and tested against the Fireweave-owned `PostHogClientApi` transport seam, but **`PostHogAdapter.create(config)` fails with `UnsupportedCapability` until PostHog publishes the artifact**. Binding the real SDK is one adapter-internal class once it exists.

Today you have two options:

1. **Inject a `PostHogClientApi` implementation** (your own thin HTTP client against `/flags?v=2`, or a test double — see `examples/java` for a working offline stub):

```java
PostHogAdapter adapter = new PostHogAdapter(myPostHogClientApi);  // injected; never closed by Fireweave
FireweaveConfig config = FireweaveConfig.builder()
    .projectApiKey(System.getenv("POSTHOG_PROJECT_API_KEY"))
    .host("https://us.i.posthog.com")
    .build();
FireweaveRuntime runtime = new FireweaveRuntime(config, adapter);
```

2. **Use the `InMemoryAdapter`** for everything until the upstream artifact ships ([testing.md](testing.md)).

The seam passes explicit `distinctId` + properties on every call (no ThreadLocal request context), and surfaces snapshot staleness: stale results resolve with reason `STALE` + `fireweave.fromCache`, and the runtime reflects `STALE` **[PostHog-specific]** (the vendor Java SDK's ~5-minute per-user remote cache is documented, never hidden).

## Context mapping (all languages)

| Fireweave / OpenFeature | PostHog |
| --- | --- |
| `targetingKey` | `distinct_id` (required; never auto-generated — see [identity.md](identity.md)) |
| Non-reserved context attributes | `person_properties` |
| Group carriers ([identity.md](identity.md#groups)) | `groups` / `group_properties` |
| `$`-prefixed attributes | Vendor directives (e.g. `$process_person_profile`), passed through — not person properties |

## Local development without a PostHog account

The repo ships a deterministic PostHog-protocol stub (`test-server/`): `/flags?v=2`, definitions poll, `/batch/`, plus scriptable fault modes (401/429/500/delay/invalid JSON/quota-limited). Point any adapter's `host` at it:

```bash
node test-server/implementation/server.mjs        # listens on 127.0.0.1:3901
POSTHOG_HOST=http://127.0.0.1:3901 POSTHOG_API_KEY=phc_example node examples/node/index.mjs --posthog
```

See [testing.md](testing.md#the-posthog-protocol-test-server).
