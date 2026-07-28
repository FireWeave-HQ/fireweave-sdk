# Fireweave SDK

Open-source, [OpenFeature](https://openfeature.dev)-compatible, **server-first** feature-flag SDK for **Node.js, Python, Go, and Java**, with release-safety extensions (releases, exposures, signals, capabilities).

**Production model (ADR-0005):** applications use a **Fireweave** project key and talk to **fw-server**. fw-server proxies evaluate/capture to PostHog (or a future provider). Apps do **not** embed PostHog `phc_`/`phs_`/`phx_` keys. A direct PostHog adapter remains available as an advanced escape hatch only.

> **Status: pre-release (0.1.0).**
>
> - Repo: https://github.com/FireWeave-HQ/fireweave-sdk — staging publish authorized; configure trusted publishers before first non-dry-run release ([publish-readiness](docs/orchestration/publish-readiness.md)).
> - **Fireweave remote adapter is implemented** (`FireweaveRemoteAdapter` → `POST /v1/flags/evaluate` + `/v1/capture`). Examples stay offline (`InMemoryAdapter`) by default; use `--remote` / `FW_API_URL` against the test-server stub or fw-server. Direct `PostHogAdapter` is an advanced escape hatch.
> - **License**: MIT ([LICENSE](LICENSE)).

## Why OpenFeature

Flag evaluation goes through the standard OpenFeature client in every language, so:

- your application code depends on the **OpenFeature API**, not on Fireweave or PostHog types — you can swap providers without rewriting call sites;
- OpenFeature hooks, domains, events, and the never-throw evaluation contract work as specified;
- Fireweave-specific functionality (release lifecycle, exposure recording, health/outcome signals, capability discovery) lives on a separate `FireweaveClient` that shares the same runtime — it never contaminates the standard flag-evaluation surface (ADR-0003).

One architecture in all four languages: **FireweaveProvider (OpenFeature) + FireweaveClient (extensions) → FireweaveRuntime → BackendAdapter** — production default is `FireweaveRemoteAdapter` (Fireweave key → fw-server); `InMemoryAdapter` for tests; optional direct `PostHogAdapter`. See [docs/architecture.md](docs/architecture.md), [ADR-0005](docs/adr/0005-fireweave-proxy-backend.md), and [spec/remote-protocol.md](spec/remote-protocol.md).

## Quickstart

Full walkthroughs: [docs/quickstart.md](docs/quickstart.md). Runnable examples: [`examples/`](examples/) (all run **offline** by default against the in-memory adapter).

Because packages are not yet published, every language installs from a repository checkout.

### Node.js (≥ 20.20)

```bash
cd sdks/node && npm install && npm run build
cd ../../examples/node && node index.mjs
```

```js
import { OpenFeature } from '@openfeature/server-sdk';
import { FireweaveProvider, FireweaveRuntime, InMemoryAdapter } from '@fireweaveai/sdk';

const runtime = new FireweaveRuntime(new InMemoryAdapter({
  flags: { 'new-checkout': { type: 'boolean', enabled: true, value: true, variant: 'on' } },
}));
await OpenFeature.setProviderAndWait(new FireweaveProvider(runtime));
const enabled = await OpenFeature.getClient()
  .getBooleanValue('new-checkout', false, { targetingKey: 'user_42' });
await OpenFeature.close();
```

### Python (≥ 3.10)

```bash
python -m venv .venv && .venv/bin/pip install -e 'sdks/python[openfeature,posthog]'
.venv/bin/python examples/python/service.py
```

```python
from openfeature import api
from openfeature.evaluation_context import EvaluationContext
from fireweave import FireweaveRuntime, InMemoryAdapter
from fireweave.openfeature import FireweaveProvider

runtime = FireweaveRuntime(InMemoryAdapter({
    "new-checkout": {"type": "boolean", "enabled": True, "value": True, "variant": "on"},
}))
api.set_provider(FireweaveProvider(runtime))
enabled = api.get_client().get_boolean_value(
    "new-checkout", False, EvaluationContext(targeting_key="user_42"))
api.shutdown()
```

### Go (1.25)

```bash
cd examples/go && go run .
```

```go
adapter := inmemory.New(inmemory.WithFlags(map[string]inmemory.Flag{
    "new-checkout": {Type: fireweave.FlagTypeBoolean, Enabled: true, Value: true, Variant: "on"},
}))
runtime := fireweave.NewRuntime(adapter, fireweave.Config{})
client := fireweave.NewClient(runtime)
_ = of.SetProviderAndWait(fwprovider.NewProvider(client))
enabled := of.NewClient("app").Boolean(ctx, "new-checkout", false,
    of.NewEvaluationContext("user_42", nil))
_ = of.Shutdown()
```

### Java (≥ 11)

```bash
cd sdks/java && mvn install
cd ../../examples/java && mvn -q compile exec:java
```

```java
FireweaveRuntime runtime = new FireweaveRuntime(
    FireweaveConfig.builder().build(), new InMemoryAdapter(flags));
OpenFeatureAPI api = OpenFeatureAPI.getInstance();
api.setProviderAndWait("app", new FireweaveProvider(runtime));
boolean enabled = api.getClient("app")
    .getBooleanValue("new-checkout", false, new MutableContext("user_42"));
api.shutdown();
```

## PostHog-backed evaluation

On **Node, Python, and Go**, point the same code at PostHog by swapping the adapter — [docs/posthog.md](docs/posthog.md) covers key types, remote vs. local evaluation, polling, and quota behavior:

- **`phc_…` project API key** — remote evaluation via `/flags?v=2`. Public-by-design, but this SDK is server-only (ADR-0004).
- **`phs_…` / `phx_…` secret keys** — enable local evaluation (in-process, definitions polled in the background). **Secrets: server-side only, never in frontend bundles.**

**Java:** PostHog is **seam only / not production-ready** — no create-from-config live client until upstream publishes a server SDK ([docs/posthog.md#java](docs/posthog.md#java)).

Identity: the OpenFeature `targetingKey` maps 1:1 to the PostHog `distinct_id`. The SDK never fabricates anonymous IDs — see [docs/identity.md](docs/identity.md).

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/quickstart.md](docs/quickstart.md) | Five-minute path per language: install → provider → boolean flag → shutdown |
| [docs/openfeature.md](docs/openfeature.md) | Resolvers, detailed resolution, context, domains, hooks |
| [docs/extensions.md](docs/extensions.md) | Fireweave-native APIs: releases, exposures, signals, guardrails, capabilities |
| [docs/posthog.md](docs/posthog.md) | PostHog-backed usage: keys, eval modes, polling, quota, per-language init |
| [docs/testing.md](docs/testing.md) | `InMemoryAdapter` patterns and the PostHog-protocol test server |
| [docs/identity.md](docs/identity.md) | `targetingKey` → `distinct_id`, anonymous strategy, groups |
| [docs/concepts.md](docs/concepts.md) | Decision model, reasons, error taxonomy, capability matrix |
| [docs/lifecycle.md](docs/lifecycle.md) | Init, readiness, shutdown, after-shutdown behavior |
| [docs/migration.md](docs/migration.md) | From direct PostHog SDK calls; from another OpenFeature provider |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Common failure modes and what they mean |
| [docs/compatibility.md](docs/compatibility.md) | Per-language version and feature matrix, known gaps |
| [docs/versioning.md](docs/versioning.md) | Semver policy, spec version, deprecation policy |
| [docs/architecture.md](docs/architecture.md) | Design: layers, lifecycle, data model, ADR index |

## Repository layout

```
sdks/node|python|go|java   Language SDKs (each with its own tests + conformance harness)
examples/<lang>            Runnable examples (offline by default)
spec/                      Canonical JSON Schemas (v0.1.0) — source of truth
contracts/                 Cross-language conformance fixtures + error taxonomy
test-server/               Deterministic PostHog-protocol stub (Node, zero-dep)
docs/                      User docs, architecture, ADRs
```

Conformance: **65** shared fixtures. Current: Python 65/65, Go 65/65, Java 64/65 (+1 numeric skip), Node 63/65 (+2 numeric skips) — every skip is a pre-declared, documented numeric-representation limitation (see [docs/compatibility.md](docs/compatibility.md)).

## Contributing

Contributions are accepted under the **Developer Certificate of Origin** (sign-off, not a CLA) — see [CONTRIBUTING.md](CONTRIBUTING.md), the [Code of Conduct](CODE_OF_CONDUCT.md), and [GOVERNANCE.md](GOVERNANCE.md). Vulnerability reports: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) — ratification of the license choice is pending a company decision; do not redistribute packages built from this repository until the license is ratified and publication is authorized.
