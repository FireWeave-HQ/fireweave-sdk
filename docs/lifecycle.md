# Lifecycle: init, readiness, shutdown

One state machine in every language (`docs/architecture.md` §3):

```
UNINITIALIZED ── init() ──► INITIALIZING ──► READY ◄──recovery──► STALE / ERROR
                                 │                     │
                          fatal config/auth        shutdown()
                                 ▼                     ▼
                               FATAL ─────────────► SHUTDOWN   (idempotent, terminal)
```

OpenFeature status mapping: `UNINITIALIZED`/`INITIALIZING` → `NOT_READY`; `READY` → `READY`; `STALE` → `STALE`; `ERROR` → `ERROR`; `FATAL` → `FATAL`; `SHUTDOWN` → `NOT_READY`. The OpenFeature SDK synthesizes `PROVIDER_READY` / `PROVIDER_ERROR` events from the provider's `initialize` outcome.

## Initialization

Init order everywhere: **validate config → construct adapter → adapter init → READY**. Configuration/auth failures are `FATAL` (OpenFeature `PROVIDER_FATAL`); transient failures land in `ERROR` and can recover. Init is **idempotent** — registering the provider and constructing a `FireweaveClient` against the same runtime initializes once.

Readiness means: remote mode — client constructed successfully; local-eval mode — at least one successful definitions fetch.

### Node

```js
// Recommended: actually wait for readiness.
await OpenFeature.setProviderAndWait(new FireweaveProvider(runtime, { lazyReady: false }));

// Default (lazyReady: true): initialize() returns immediately, init continues in
// the background, and evaluations return defaults with PROVIDER_NOT_READY
// (fireweave.errorKind = NotReady) until READY.
await OpenFeature.setProviderAndWait(new FireweaveProvider(runtime));

// Fireweave-native (no OpenFeature): FireweaveClient.initialize() / runtime.initialize().
```

Observe state: `runtime.getState()`, `runtime.onStateChange(listener)`.

### Python

```python
api.set_provider(FireweaveProvider(runtime))        # initializes the runtime
# Fail fast on bad backend config (PROVIDER_FATAL event):
api.set_provider(FireweaveProvider(runtime, backend_required=True))
# Fireweave-native: runtime.initialize(backend_required=True)
```

After a recorded `FATAL`, the provider does not raise from evaluations — every evaluation degrades to a default-valued decision carrying the precise error taxonomy.

### Go

```go
if err := of.SetProviderAndWait(fwprovider.NewProvider(client)); err != nil { … }
// Fireweave-native: runtime.Initialize(ctx) — serialized; concurrent callers
// observe a single adapter initialization. Every blocking call honors ctx.
```

### Java

```java
api.setProviderAndWait("domain", new FireweaveProvider(runtime));
// Fireweave-native: runtime state is observable via runtime.state().
```

## While running: READY, STALE, ERROR

- **STALE** — the backend is degraded but last-good definitions/cache are still serving. Decisions carry reason `STALE` and/or `fireweave.fromCache: true`. Values remain trustworthy but may lag the flag dashboard. Recovery is automatic on the next successful poll.
- **ERROR** — evaluation degraded to defaults (`PROVIDER_NOT_READY`-class decisions) until the adapter recovers.
- Meaningful definition refreshes surface as configuration-changed events where the OpenFeature SDK supports them.

## Shutdown

Shutdown belongs to the **runtime**; every entry point converges on it and it is **idempotent** (double-close is a no-op):

| Language | Standard path | Fireweave-native path |
| --- | --- | --- |
| Node | `await OpenFeature.close()` (calls provider `onClose`) | `await client.shutdown()` (flushes exposures first) / `await runtime.shutdown()` |
| Python | `api.shutdown()` | `client.shutdown()` (flushes exposures; also a context manager) |
| Go | `of.Shutdown()` / `of.ShutdownWithContext(ctx)` | `runtime.Shutdown(ctx)` |
| Java | `api.shutdown()` | `client.close()` (AutoCloseable) / `runtime.shutdown()` |

Semantics: stop accepting new work → flush pending telemetry → close the adapter under a **deadline** (default 10 s; Go bounds posthog-go's otherwise-indefinite `Close`, configurable via `CloseTimeout`/`shutdownTimeoutMs`/`shutdown_timeout_ms`). Shutdown never throws; flush failures are swallowed (telemetry loss is acceptable, evaluation correctness is not).

Injected vendor clients (advanced init) are **not** shut down by Fireweave — whoever constructed the client owns its lifecycle.

Note (Go/Java): the Fireweave-native shutdown does **not** implicitly flush the extension exposure queue — call `Exposures().Flush(ctx)` / `exposures().flush()` first if you have queued exposures ([extensions.md](extensions.md#exposures)).

## After shutdown

- OpenFeature evaluations return **defaults** with `PROVIDER_NOT_READY` and `flagMetadata["fireweave.errorKind"] = "AlreadyClosed"` — distinguishable from a not-yet-ready provider.
- Extension calls fail fast with `AlreadyClosed` result objects / errors.
- A shut-down runtime is terminal for that instance: construct a new runtime rather than re-initializing (`initialize()` after shutdown fails with `AlreadyClosed`).

## Concurrency

Runtimes and clients are safe for concurrent evaluation on one instance in all four languages (Go: race-tested; Java: volatile-state reads, no evaluation locking; Python: thread-safe sync core, `fireweave.aio` for asyncio; Node: single-threaded async). Evaluations racing a shutdown either complete or observe a typed `AlreadyClosed` default decision — never a crash.

Recommended server pattern: **one runtime per process per backend project**, created at boot, shared everywhere (it's cheap to share and expensive to duplicate — each runtime may run its own poller), shut down once on process exit.
