# fireweave (Python SDK)

Fireweave polyglot SDK for Python — OpenFeature-compatible, server-first flag
evaluation with release-safety extensions (spec v0.1.0).

- **Core**: zero runtime dependencies (`fireweave` + `InMemoryAdapter`).
- **Extras**: `fireweave[posthog]` (PostHog backend, `posthog==7.31.0`),
  `fireweave[openfeature]` (OpenFeature provider, `openfeature-sdk>=0.10,<0.11`).

## Quick start (offline, in-memory)

```python
from fireweave import FireweaveClient, FireweaveRuntime, InMemoryAdapter

adapter = InMemoryAdapter({
    "new-checkout": {"type": "boolean", "enabled": True, "variant": "on", "value": True},
})
runtime = FireweaveRuntime(adapter)
runtime.initialize()
client = FireweaveClient(runtime)

assert client.flags.get_boolean_value("new-checkout", False) is True
client.shutdown()
```

## OpenFeature

```python
from openfeature import api
from fireweave import FireweaveRuntime, InMemoryAdapter
from fireweave.openfeature import FireweaveProvider

api.set_provider(FireweaveProvider(FireweaveRuntime(InMemoryAdapter({...}))))
client = api.get_client()
client.get_boolean_value("new-checkout", False)
```

## PostHog backend

```python
from fireweave import FireweaveConfig, FireweaveRuntime, FireweaveClient
from fireweave.adapters.posthog import PostHogAdapter

config = FireweaveConfig(project_api_key="phc_...", host="https://us.i.posthog.com")
runtime = FireweaveRuntime(PostHogAdapter(config=config), config)
runtime.initialize(backend_required=True)
client = FireweaveClient(runtime)
```

## Sync / async

The core is a thread-safe **sync** runtime; asyncio servers use
`fireweave.aio.AsyncFireweaveClient`, which offloads calls via
`asyncio.to_thread`. See `docs/adr/0004` and the module docstring.

## Development

```bash
python -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/pytest                                   # unit + conformance tests
.venv/bin/python conformance/run_conformance.py    # normalized results JSON
```
