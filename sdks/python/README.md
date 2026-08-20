# fireweave (Python SDK)

Fireweave release-engineering SDK for Python — **control points** and target
registration, the two v1 capabilities (spec/control-points.md "Scope of v1").

- **Zero runtime dependencies.**
- **The SDK reads no environment variables** — every option is an explicit
  argument to `init_fireweave` (spec/modes.md).
- **No vendor SDK, key, or hostname in your process.** Applications hold a
  Fireweave project key and talk to fw-server; which backend fw-server
  forwards to is fw-server's concern.

## Quick start (production path)

```python
from fireweave import RegisterTargetOptions, init_fireweave, EvaluationContext

# mode is required and never inferred (spec/modes.md); api_key/api_url are
# explicit options — the SDK reads no environment variables.
client = init_fireweave(
    mode="remote",
    api_key="project-api-key_...",
    api_url="https://app-server.fireweave.ai",
)

# Once per login: the durable facts your targeting rules match on.
client.register_target(
    "user_42", RegisterTargetOptions(kind="user", properties={"plan": "pro"})
)

# Per request.
enabled = client.control_points.get_boolean_value(
    "new-checkout", False, EvaluationContext("user_42")
)

client.shutdown()
```

## Quick start (offline, in-memory)

```python
from fireweave import FireweaveClient, FireweaveRuntime, InMemoryAdapter

adapter = InMemoryAdapter({
    "new-checkout": {"enabled": True, "variant": "on", "value": True},
})
runtime = FireweaveRuntime(adapter)
runtime.initialize()
client = FireweaveClient(runtime)

assert client.control_points.get_boolean_value("new-checkout", False) is True
client.shutdown()
```

## Quick start (local dev — no network, no credentials)

```python
from fireweave import init_fireweave

client = init_fireweave(mode="local", local={"control_points": {"new-checkout": True}})
client.control_points.get_boolean_value("new-checkout", False)  # -> True
client.register_target("user_42")  # recorded in-process + traced; nothing sent
client.shutdown()
```

## The nine methods

`get_boolean_value` / `get_string_value` / `get_number_value` /
`get_object_value`, their `*_details` counterparts (return the whole
`Decision` — `reason`, `error_kind`, `flag_metadata`, ... — instead of just
the value), and the general-form `evaluate`. All nine live under
`client.control_points`; `client.flags` is an identical, fully-supported
alias (`client.flags is client.control_points`).

`get_integer_value` is a deprecated alias of `get_number_value` — spec fixes
the method as **number**, not integer (`Decision.value` is `jsonValue`). It
still works and delegates straight through; it logs one `DeprecationWarning`
per process the first time it's called.

## Module layout

| Module | Responsibility |
| --- | --- |
| `domain/` | Pure types + validation: `errors.py`, `types.py`, `context.py`, `decision.py`, `target.py`, `validation.py`. No I/O, no imports from `application/`/`infrastructure/`. |
| `application/runtime.py` | Lifecycle state machine, context layering, the evaluation pipeline. Evaluation never raises. |
| `application/client.py` | `FireweaveClient` — `control_points`, `register_target`, `invoke_capability` (degrades; v1 has no supported capabilities). |
| `application/mode.py` | `init_fireweave` — the single entry point and sanctioned composition root (the only file allowed to import concrete adapters). |
| `application/ports.py` | The `BackendAdapter` boundary. |
| `infrastructure/adapters/remote.py` | `FireweaveRemoteAdapter` — the production backend (`POST /v1/flags/evaluate`, `POST /v1/targets/register`). |
| `infrastructure/adapters/local.py` | `FireweaveLocalAdapter` — the dev substrate: seeded boolean overrides, no network. `register_target` records in-process and traces the call. |
| `infrastructure/adapters/memory.py` | Deterministic fixture-driven adapter for tests. |
| `infrastructure/hosts.py` | SSRF allowlist (on by default; https required off-loopback). |

## Development

```bash
python -m venv .venv && .venv/bin/pip install -e '.[dev]'
# or: uv sync
.venv/bin/pytest    # unit tests
```

`conformance/runner.py` (the `contracts/`-fixture harness) still targets the
pre-v1 surface and is not run by `pytest` today (`tests/test_conformance.py`
skips it) — its rewrite for the v1 control-points surface is separate,
cross-language follow-up work. `conformance/surface/control-points.surface.json`
is the parity gate this package satisfies.

## License

[MIT](./LICENSE).
