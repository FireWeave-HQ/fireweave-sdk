# Testing your integration

Two Fireweave-provided tools mean your tests never need a backend account or network:

1. **`InMemoryAdapter`** — a deterministic, fixture-driven `BackendAdapter` in every language. Bind the real provider + real OpenFeature client to it; assert on real evaluation behavior with zero I/O.
2. **The protocol test server** (`test-server/`) — a zero-dependency Node HTTP stub with scriptable fault modes. It serves the Fireweave-native routes (`/v1/flags/evaluate`, `/v1/capture`, `/v1/targets/register`) for exercising `FireweaveRemoteAdapter`'s HTTP path, plus legacy vendor routes for the languages that still ship a vendor adapter.

Both are **[Fireweave extension]** test infrastructure; the evaluation semantics they exercise are the same canonical semantics as production.

## InMemoryAdapter

### Flag definitions

All languages accept the same conceptual definition — `type`, `enabled`, `value`, optional `variant`, `payload`, `metadata.version`, and optional match conditions that gate the flag on context attributes (no match → your default):

### Node

```js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { OpenFeature } from '@openfeature/server-sdk';
import { FireweaveProvider, FireweaveRuntime, InMemoryAdapter } from '@fireweaveai/sdk';

test('beta cohort gets the new checkout', async () => {
  const adapter = new InMemoryAdapter({
    flags: {
      'new-checkout': {
        type: 'boolean', enabled: true, value: true, variant: 'on',
        matchAttribute: { cohort: 'beta' },        // matches only when context.cohort === 'beta'
      },
    },
  });
  const runtime = new FireweaveRuntime(adapter);
  await OpenFeature.setProviderAndWait('t', new FireweaveProvider(runtime, { lazyReady: false }));
  const client = OpenFeature.getClient('t');

  assert.equal(await client.getBooleanValue('new-checkout', false,
    { targetingKey: 'u1', cohort: 'beta' }), true);
  assert.equal(await client.getBooleanValue('new-checkout', false,
    { targetingKey: 'u2' }), false);               // no match → default
  await OpenFeature.close();
});
```

Node fault injection (typed faults without HTTP): `new InMemoryAdapter({ fault: { kind: 'Timeout' } })` makes every resolve fail with that error kind; `initError: 'Configuration'` makes `initialize()` fail (runtime → FATAL); `initGate` holds initialization open for cold-start tests. `setFlags()` / `setFault()` mutate live. Recorded exposures are available on the adapter for assertions.

### Python

```python
from fireweave import FireweaveClient, FireweaveRuntime, InMemoryAdapter

def test_beta_cohort_gets_new_checkout():
    adapter = InMemoryAdapter({
        "new-checkout": {
            "type": "boolean", "enabled": True, "value": True, "variant": "on",
            "matchAttribute": {"cohort": "beta"},
        },
    })
    runtime = FireweaveRuntime(adapter)
    runtime.initialize()
    with FireweaveClient(runtime) as client:
        from fireweave import EvaluationContext
        assert client.flags.get_boolean_value(
            "new-checkout", False, EvaluationContext("u1", {"cohort": "beta"})) is True
        assert client.flags.get_boolean_value(
            "new-checkout", False, EvaluationContext("u2", {})) is False
```

`adapter.set_flags({...})` swaps definitions live (drives OpenFeature `CONFIG_CHANGED`-style tests). The FastAPI example (`examples/python/fastapi_app.py` + `test_fastapi_app.py`) shows dependency-injecting the runtime into an async app via `fireweave.aio.AsyncFireweaveClient`.

### Go

```go
func TestBetaCohortGetsNewCheckout(t *testing.T) {
	adapter := inmemory.New(inmemory.WithFlags(map[string]inmemory.Flag{
		"new-checkout": {
			Type: fireweave.FlagTypeBoolean, Enabled: true, Value: true, Variant: "on",
			MatchAttributes: map[string]any{"cohort": "beta"},
		},
	}))
	runtime := fireweave.NewRuntime(adapter, fireweave.Config{})
	if err := of.SetProviderAndWait(fwprovider.NewProvider(fireweave.NewClient(runtime))); err != nil {
		t.Fatal(err)
	}
	client := of.NewClient("t")
	if !client.Boolean(context.Background(), "new-checkout", false,
		of.NewEvaluationContext("u1", map[string]any{"cohort": "beta"})) {
		t.Fatal("expected true for beta cohort")
	}
}
```

`inmemory.WithInitError(err)` simulates initialization failure (runtime → FATAL/ERROR). The adapter also implements `fireweave.TelemetrySink`, so flushed exposures and signals are capturable in tests.

### Java

`InMemoryAdapter` lives in the `ai.fireweave:fireweave-testing` module (add it with `<scope>test</scope>`):

```java
Map<String, FlagDefinition> flags = Map.of("new-checkout",
    FlagDefinition.fromJson(mapper.readTree(
        "{\"type\":\"boolean\",\"enabled\":true,\"variant\":\"on\",\"value\":true}")));
InMemoryAdapter adapter = new InMemoryAdapter(flags);
FireweaveRuntime runtime = new FireweaveRuntime(FireweaveConfig.builder().build(), adapter);
OpenFeatureAPI.getInstance().setProviderAndWait("t", new FireweaveProvider(runtime));

boolean enabled = OpenFeatureAPI.getInstance().getClient("t")
    .getBooleanValue("new-checkout", false, new MutableContext("u1"));
```

Fault simulation: `new InMemoryAdapter(flags, FaultConfig...)` deterministically simulates HTTP-status faults, invalid JSON, network errors, offline, quota-limiting, and delays (delay compares against the configured timeout — nothing sleeps). Assertion helpers: `evaluateCallCount()`, `lastContext()`, `deliveredExposures()`, `setStale(true)` for stale-cache scenarios.

## The protocol test server

Zero-dependency Node stub (loopback-only by default). Use it for adapter-level integration tests — anything where you want the real HTTP path rather than the in-memory seam.

```bash
node test-server/implementation/server.mjs            # http://127.0.0.1:3901
node test-server/implementation/server.mjs --port 4000
```

Fireweave-native endpoints (what `FireweaveRemoteAdapter` speaks): `POST /v1/flags/evaluate`, `POST /v1/capture`, `POST /v1/targets/register`, `GET /health`. Auth is `Authorization: Bearer <FW_PROJECT_API_KEY>`.

Legacy vendor endpoints, for the languages that still ship a vendor adapter: `POST /flags?v=2`, `GET /flags/definitions?token=…`, `POST /batch/`.

Auth: any non-empty key is accepted unless the server was started with a configured one. Use obviously fake keys (`project-api-key_dev`).

Control plane for tests:

| Call | Effect |
| --- | --- |
| `POST /_test/fault` `{"mode":"500","ttlRequests":1,"applyTo":"evaluate"}` | Inject a fault: `delay`, `401`, `429`, `500`, `invalid_json`, `truncated`, `quota_limited`. `applyTo` selects the route: `evaluate` / `capture` for the Fireweave routes, `flags` / `definitions` / `batch` for the legacy ones, or `all` |
| `POST /_test/flags` | Replace the `/flags?v=2` success body |
| `POST /_test/definitions` | Replace the definitions body (bump `version` to simulate config change) |
| `POST /_test/reset` | Restore fixture defaults, clear faults/events |
| `GET /_test/events` | Captured events in insert order: `{ events }` from the legacy batch route, `{ fwEvents }` from `POST /v1/capture` |
| `GET /_test/requests` | Request log — which routes the adapter actually called |

Faults can also be triggered per-request with header `X-Fw-Test-Fault: <mode>` or query `?fault=<mode>`. Full contract: [`test-server/README.md`](../test-server/README.md).

Point an adapter at it (works in every language — it is just a host):

```bash
FW_API_URL=http://127.0.0.1:3901 FW_PROJECT_API_KEY=project-api-key_dev \
  node examples/node/index.mjs --remote
```

Note that the stub serves **its own fixture control points** (`fw-bool-on`, …, from `test-server/fixtures/flags-v2-success.json`) — keys your app expects will resolve `FLAG_NOT_FOUND` → default unless you `POST /_test/flags` a body containing them. This is a correct, useful test of your default-value behavior.

## What to test (checklist)

- Flag on / off / no-match → value, variant, `reason`.
- Missing flag → default + `FLAG_NOT_FOUND` (never a throw).
- Type mismatch (e.g. string flag read as boolean) → default + `TYPE_MISMATCH`.
- Missing `targetingKey` with `requireTargetingKey` enabled → default + `TARGETING_KEY_MISSING`.
- Evaluation before init and after shutdown → default + `PROVIDER_NOT_READY` (with `fireweave.errorKind` = `NotReady` / `AlreadyClosed` in flagMetadata).
- Extension flows: bound release context, health signal recorded, exposures deduped and flushed.

## The conformance suite (contributors)

The cross-language behavioral contract lives in `contracts/` (63 fixtures) and runs against every SDK through the real OpenFeature client — see [CONTRIBUTING.md](../CONTRIBUTING.md#build--test-per-language) for per-language commands and `contracts/README.md` for the fixture format, normalization rules, and skip policy.
