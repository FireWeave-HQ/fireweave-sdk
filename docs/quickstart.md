# Quickstart

Five minutes per language: install → configure a provider → evaluate a boolean flag → shut down cleanly.

> **Packages are not yet published.** Every path below installs from a checkout of this repository (path/workspace installs). The import names shown (`@fireweaveai/sdk`, `fireweave`, `ai.fireweave:*`) are the working package names and already work for local installs.

Every snippet below runs **offline** using the deterministic `InMemoryAdapter` — no PostHog account needed. To point the same code at PostHog, swap the adapter as shown in [posthog.md](posthog.md). Complete, runnable versions of these programs live in [`examples/`](../examples/).

## Node.js (≥ 20.20)

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

Run it: `node examples/node/index.mjs`.

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

- Point at PostHog (Node/Python/Go): [posthog.md](posthog.md). Java remains seam-only until upstream publishes a server SDK.
- Detailed resolution, hooks, domains: [openfeature.md](openfeature.md).
- Release contexts, health signals, exposures: [extensions.md](extensions.md).
- Testing your integration without a network: [testing.md](testing.md).
