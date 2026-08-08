# Quickstart

Five minutes per language: install → configure a backend → evaluate a boolean control point → shut down cleanly.

> **Packages are not yet published.** Every path below installs from a checkout of this repository (path/workspace installs). The import names shown (`@fireweaveai/sdk`, `fireweave`, `ai.fireweave:*`) are the working package names and already work for local installs.

Every snippet below runs **offline** using the deterministic `InMemoryAdapter` — no network needed. For production, use `FireweaveRemoteAdapter` with `FW_API_URL` + `FW_PROJECT_API_KEY` (Fireweave credentials → fw-server; see below). Complete, runnable programs live in [`examples/`](../examples/) (`--remote` hits the test-server stub).

On Node, `FireweaveRemoteAdapter` is the only network adapter ([ADR-0006](adr/0006-node-drops-direct-posthog-adapter.md)). Python and Go still ship an optional direct-vendor escape hatch, documented in [posthog.md](posthog.md).

## Node.js (≥ 20.20), Bun (≥ 1.2), Deno (≥ 2.0)

The Node package is runtime-agnostic — the same build runs on all three ([runtimes.md](runtimes.md)).

**Install (from repo checkout).** Build the SDK once, then depend on it by path:

```bash
git clone https://github.com/FireWeave-HQ/fireweave-sdk && cd fireweave-sdk
(cd sdks/node && npm install && npm run build)
# in your app:
npm install ../fireweave-sdk/sdks/node/packages/sdk @openfeature/server-sdk
```

**Evaluate and shut down:**

```js
import { OpenFeature } from '@openfeature/server-sdk';
import { FireweaveProvider, FireweaveRuntime, InMemoryAdapter } from '@fireweaveai/sdk';

// 1. Adapter + runtime. InMemoryAdapter takes { flags: { key: definition } }.
const runtime = new FireweaveRuntime(new InMemoryAdapter({
  flags: {
    'new-checkout': { type: 'boolean', enabled: true, value: true, variant: 'on' },
  },
}));

// 2. Register with OpenFeature and wait for readiness.
await OpenFeature.setProviderAndWait(new FireweaveProvider(runtime, { lazyReady: false }));
const client = OpenFeature.getClient();

// 3. Boolean evaluation with a targeting context (never throws; returns the
//    default on any failure).
const enabled = await client.getBooleanValue('new-checkout', false, {
  targetingKey: 'user_42',
});
console.log('new-checkout:', enabled);

// 4. Clean shutdown: flushes and closes the provider.
await OpenFeature.close();
```

Run it: `node examples/node/index.mjs` — or `bun examples/node/index.mjs`, or
`deno run --allow-net --allow-env --allow-read examples/node/index.mjs`.

### The Fireweave-native surface

The OpenFeature client above covers control-point evaluation. The release-safety
capabilities live on `FireweaveClient`, sharing the same runtime:

```js
import { FireweaveClient } from '@fireweaveai/sdk';

const fireweave = new FireweaveClient(runtime);

// Register durable targeting properties once, at login.
await runtime.registerTarget('user_42', {
  kind: 'user',
  properties: { plan: 'pro', region: 'eu-west' },
});

// Detailed, Decision-returning evaluation without OpenFeature.
const decision = await fireweave.controlPoints.evaluate('new-checkout', 'boolean', false, {
  targetingKey: 'user_42',
});
console.log(decision.reason, decision.variant, decision.metadata);

// Release lifecycle + outcome reporting.
fireweave.releases.setContext({
  rolloutId: 'rollout_01HZXEXAMPE000000000000001',
  stampIds: ['stmp_01HZXEXAMPE000000000000001'],
});
fireweave.releases.start();
fireweave.signals.recordOutcome({ name: 'checkout', status: 'completed' });
fireweave.releases.complete();
```

Details: [extensions.md](extensions.md). `client.flags` is a retained alias for
`client.controlPoints` — see [ADR-0007](adr/0007-control-point-vocabulary.md).

### Production (Fireweave remote)

```js
import { FireweaveRemoteAdapter, FireweaveProvider, FireweaveRuntime } from '@fireweaveai/sdk';
import { OpenFeature } from '@openfeature/server-sdk';

const adapter = new FireweaveRemoteAdapter({
  apiUrl: process.env.FW_API_URL,                 // fw-server base URL
  apiKey: process.env.FW_PROJECT_API_KEY,         // project-api-key_…
});
const runtime = new FireweaveRuntime(adapter);
await OpenFeature.setProviderAndWait(new FireweaveProvider(runtime, { lazyReady: false }));
```

Against the repo stub: start `node test-server/implementation/server.mjs`, then
`FW_API_URL=http://127.0.0.1:3901 FW_PROJECT_API_KEY=project-api-key_dev node examples/node/index.mjs --remote`.

## Python (≥ 3.10)

**Install (from repo checkout):**

```bash
git clone https://github.com/FireWeave-HQ/fireweave-sdk && cd fireweave-sdk
python -m venv .venv
.venv/bin/pip install -e 'sdks/python[openfeature]'   # add ,posthog for the PostHog adapter
```

**Evaluate and shut down:**

```python
from openfeature import api
from openfeature.evaluation_context import EvaluationContext
from fireweave import FireweaveRuntime, InMemoryAdapter
from fireweave.openfeature import FireweaveProvider

# 1. Adapter + runtime. InMemoryAdapter takes {flag_key: definition}.
runtime = FireweaveRuntime(InMemoryAdapter({
    "new-checkout": {"type": "boolean", "enabled": True, "value": True, "variant": "on"},
}))

# 2. Register with OpenFeature (this initializes the runtime).
api.set_provider(FireweaveProvider(runtime))
client = api.get_client()

# 3. Boolean evaluation with a targeting context.
enabled = client.get_boolean_value(
    "new-checkout", False, EvaluationContext(targeting_key="user_42"))
print("new-checkout:", enabled)

# 4. Clean shutdown.
api.shutdown()
```

Run the full example: `.venv/bin/python examples/python/service.py`.

## Go (1.25)

**Install (from repo checkout).** The module path is `github.com/FireWeave-HQ/fireweave-sdk/sdks/go`; until the repository is public on that path, use a `replace` directive:

```bash
git clone https://github.com/FireWeave-HQ/fireweave-sdk
# in your app's go.mod:
#   require github.com/FireWeave-HQ/fireweave-sdk/sdks/go v0.0.0
#   replace github.com/FireWeave-HQ/fireweave-sdk/sdks/go => ../fireweave-sdk/sdks/go
```

**Evaluate and shut down:**

```go
package main

import (
	"context"
	"fmt"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/adapters/inmemory"
	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/fireweave"
	fwprovider "github.com/FireWeave-HQ/fireweave-sdk/sdks/go/openfeature"
	of "github.com/open-feature/go-sdk/openfeature"
)

func main() {
	ctx := context.Background()

	// 1. Adapter + runtime + Fireweave client (the Go provider wraps the client).
	adapter := inmemory.New(inmemory.WithFlags(map[string]inmemory.Flag{
		"new-checkout": {Type: fireweave.FlagTypeBoolean, Enabled: true, Value: true, Variant: "on"},
	}))
	runtime := fireweave.NewRuntime(adapter, fireweave.Config{})
	client := fireweave.NewClient(runtime)

	// 2. Register with OpenFeature and wait for READY.
	if err := of.SetProviderAndWait(fwprovider.NewProvider(client)); err != nil {
		panic(err)
	}

	// 3. Boolean evaluation with a targeting context.
	enabled := of.NewClient("app").Boolean(ctx, "new-checkout", false,
		of.NewEvaluationContext("user_42", nil))
	fmt.Println("new-checkout:", enabled)

	// 4. Clean shutdown (bounded by context if you use ShutdownWithContext).
	of.Shutdown()
}
```

Run the full example: `cd examples/go && go run .`

## Java (≥ 11)

**Install (from repo checkout).** Build into your local Maven repository, then depend on the local artifacts:

```bash
git clone https://github.com/FireWeave-HQ/fireweave-sdk && cd fireweave-sdk/sdks/java
mvn install    # installs ai.fireweave:fireweave-sdk, :fireweave-openfeature, :fireweave-testing, :fireweave-adapter-posthog (0.1.0-SNAPSHOT) locally
```

```xml
<dependency><groupId>ai.fireweave</groupId><artifactId>fireweave-sdk</artifactId><version>0.1.0-SNAPSHOT</version></dependency>
<dependency><groupId>ai.fireweave</groupId><artifactId>fireweave-openfeature</artifactId><version>0.1.0-SNAPSHOT</version></dependency>
<dependency><groupId>ai.fireweave</groupId><artifactId>fireweave-testing</artifactId><version>0.1.0-SNAPSHOT</version><scope>test</scope></dependency>
```

**Evaluate and shut down:**

```java
import ai.fireweave.openfeature.FireweaveProvider;
import ai.fireweave.sdk.FireweaveConfig;
import ai.fireweave.sdk.FireweaveRuntime;
import ai.fireweave.testing.FlagDefinition;
import ai.fireweave.testing.InMemoryAdapter;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.openfeature.sdk.MutableContext;
import dev.openfeature.sdk.OpenFeatureAPI;

import java.util.Map;

public class Quickstart {
    public static void main(String[] args) throws Exception {
        // 1. Adapter + runtime (plain constructors; no DI framework needed).
        ObjectMapper m = new ObjectMapper();
        Map<String, FlagDefinition> flags = Map.of("new-checkout",
            FlagDefinition.fromJson(m.readTree(
                "{\"type\":\"boolean\",\"enabled\":true,\"variant\":\"on\",\"value\":true}")));
        FireweaveRuntime runtime = new FireweaveRuntime(
            FireweaveConfig.builder().build(), new InMemoryAdapter(flags));

        // 2. Register with OpenFeature and wait for READY.
        OpenFeatureAPI api = OpenFeatureAPI.getInstance();
        api.setProviderAndWait("app", new FireweaveProvider(runtime));

        // 3. Boolean evaluation with a targeting context.
        boolean enabled = api.getClient("app")
            .getBooleanValue("new-checkout", false, new MutableContext("user_42"));
        System.out.println("new-checkout: " + enabled);

        // 4. Clean shutdown (idempotent).
        api.shutdown();
    }
}
```

Run the full example: `cd examples/java && mvn -q compile exec:java`.

> **Java + PostHog:** **seam only / not production-ready.** There is no published PostHog Java server SDK; `PostHogAdapter.create(config)` returns `UnsupportedCapability`. Quickstart and examples use `InMemoryAdapter` (above) or an injected `PostHogClientApi` stub — never API-key-only live PostHog construction. See [posthog.md](posthog.md#java).

## Next steps

- Direct-vendor escape hatch (Python/Go only): [posthog.md](posthog.md). Removed on Node in v3; Java remains seam-only until upstream publishes a server SDK.
- Detailed resolution, hooks, domains: [openfeature.md](openfeature.md).
- Release contexts, health signals, exposures: [extensions.md](extensions.md).
- Testing your integration without a network: [testing.md](testing.md).
