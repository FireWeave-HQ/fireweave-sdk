# fireweave (Python SDK)

Fireweave release-engineering SDK for Python — **control points** and target
registration, the two v1 capabilities (spec/control-points.md "Scope of v1").

- **Zero runtime dependencies.**
- **The core SDK reads no environment variables** — every option is an explicit
  argument to `init_fireweave` (spec/modes.md). The opt-in start profile,
  `fireweave.start`, is the one documented exception
  ([ADR-0012](../../docs/adr/0012-start-profile.md)).
- **No vendor SDK, key, or hostname in your process.** Applications hold a
  Fireweave project key and talk to fw-server; which backend fw-server
  forwards to is fw-server's concern.

## Quick start (one line: the start profile)

Most apps need only this ([ADR-0012](../../docs/adr/0012-start-profile.md)). One small module and one call:

```python
# src/fireweave_setup/control_points.py: every control point the app reads, with its local value
from fireweave.start import define_control_points

control_points = define_control_points({
    "new-checkout": {"local": True, "description": "One-page checkout"},  # served only in local mode
})
```

```python
# the process entrypoint, FIRST thing: main.py, wsgi.py + asgi.py, create_app(), the Celery app module
from fireweave.start import start
from fireweave_setup.control_points import control_points

start(control_points=control_points)
```

```python
# any call site
from fireweave import EvaluationContext
from fireweave.start import fw

# @fireweave-controlpoint new-checkout
if fw.control_points.get_boolean_value("new-checkout", False, EvaluationContext(user_id)):
    ...
fw.identify(user_id, {"plan": user.plan})                                   # at sign-in
fw.control_points.get_boolean_value("nightly-reindex", False, EvaluationContext(fw.instance_key()))  # server as subject
```

Deployed environments set one variable, `FIREWEAVE_KEY` (the project key, `project-api-key_…`).
Local development needs nothing when `FIREWEAVE_ENV` (or `APP_ENV`) is `development`, `dev`,
`local` or `test`.

`fw.control_points` has exactly the core's nine methods, with the same names and arguments;
contexts are `EvaluationContext` as everywhere else. Reads are synchronous (one blocking HTTP call
each in remote mode); in an `async def` handler use
`await asyncio.to_thread(lambda: fw.control_points.get_boolean_value("new-checkout", False, ctx))`.
Never pass an unguarded `str(user.id)`: Django's `AnonymousUser.id` is `None`, and `"None"` would
be one targeting key shared by every anonymous visitor.

### Options and overrides

Every value resolves as: `start()` keyword option, then env var, then legacy name (warns once),
then default. Empty and whitespace-only values count as unset.

| Option | Env var | Default | What it does |
| --- | --- | --- | --- |
| `control_points` | — | `{}` | Local values per control point. Ignored in remote mode. |
| `mode` | — | inferred | `'remote'` or `'local'`. Overrides inference. `'remote'` without a key is a start error; `'local'` ignores a key, with one warning. |
| `environment` | `FIREWEAVE_ENV`, `APP_ENV` | — | Environment name used for inference when there is no key and no `mode`. Pass your own, e.g. `environment=settings.DEPLOY_STAGE`. `ENVIRONMENT`, `ENV`, `NODE_ENV` and the retired `FW_ENV` are not read. |
| `url` | `FIREWEAVE_URL` (legacy `FW_API_URL`, `FW_ATTEST_URL`) | from the installed version | A pre-release or dev release calls `staging-app-server.fireweave.ai`; any other calls `app-server.fireweave.ai`. Staging builds are `X.Y.ZrcN` on PyPI: install one with `pip install fireweave==X.Y.ZrcN` (no extra index; pip skips pre-releases unless pinned). Set it for a self-hosted or local fw-server: https is required except on localhost, and the host allowlist follows it. |
| `key` | `FIREWEAVE_KEY` (legacy `FW_PROJECT_API_KEY`) | — | Project key. Pass it to read from your own secret store. Browser keys (`fw_public_…`), analytics vendor keys and org or CLI tokens are rejected at start. |
| `instance_id` | `FIREWEAVE_INSTANCE_ID` | `inst_` + hash of the host name | Value of `fw.instance_key()`. Nothing is written to disk. |
| `env` | — | `os.environ` | Read values from this mapping instead of the environment (tests). |
| `log` | — | the `fireweave.start` logger | A callable taking one line, or a `logging.Logger`. Where `[fireweave]` lines go. |

`fireweave.start.SDK_VERSION` and `SDK_CHANNEL` show which version and channel are installed.

**Mode rule.** `mode` wins. Otherwise: a key means remote. No key and a development environment
name means local. Anything else (including no environment name at all) raises
`ConfigurationError` at `start()`, naming `FIREWEAVE_KEY` and where the environment name was
looked for, so a deploy that forgot its key fails instead of silently serving defaults.

**One per process.** `start()` is idempotent: a second call with the same configuration does
nothing, a different one raises `ConfigurationError`. It does no network I/O and starts no
thread, so it is ready when it returns. Call it in every process entrypoint; a forked worker
(gunicorn `--preload`, Celery prefork) rebuilds its client on its own. A read before any `start()`
starts FireWeave immediately from the environment alone (one warning); the first explicit
`start()` afterwards replaces that once, with a warning, and shuts the provisional client down
(reads in flight move to the new one). Processes that never run your entrypoint
(`manage.py`, spawned children) get the environment-only start, so prefer `FIREWEAVE_*`
variables to options for anything every process needs.

**Reads never raise.** If start fails, reads return your default (`evaluate` and the `*_details`
forms return an `ERROR` decision with the `Configuration` error) and `fw.identify()` returns
`ok=False`. In local mode, reading a key that is not in your control points returns the default and
warns once, naming the file that declared them.

**Debugging.** `fw.status()` reports what start decided: `state`, `started_by`, `mode` and
`mode_source`, `channel`, `sdk_version`, `host`, `endpoint_source`, `key_source`, `environment`,
`flag_count`, `error` and `last_error_kind`. It never includes the key. When fw-server refuses the
key (401/403), rate-limits it (429) or cannot be reached (network error, timeout, 5xx or a
redirect, which is never followed), reads serve their defaults, so a revoked key would otherwise
look like a rollout at 0%. Each of those kinds logs **one** line per process through your `log`
sink (default: the `fireweave.start` logger), naming the key's source (`FIREWEAVE_KEY`,
`start(key=...)`) or the endpoint's, and the host, never the key; `last_error_kind` keeps the
latest kind (`Authentication`, `Authorization`, `RateLimited`, `Network`, `Timeout`,
`BackendUnavailable`). `fw.client()` is the core `FireweaveClient` for anything the facade does not
cover (do not cache it: the first explicit `start()` after a read-triggered one shuts the
provisional client down); `fw.shutdown()` flushes and closes, and a later `start()` begins fresh.
Tests call `fireweave.start.reset_for_tests()` between cases.

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
`Decision` — `reason`, `error_kind`, `control_point_metadata`, ... — instead of
just the value), and the general-form `evaluate`. All nine live under
`client.control_points`; the `client.flags` alias was removed in 3.0.0
(ADR-0013).

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
| `infrastructure/adapters/remote.py` | `FireweaveRemoteAdapter` — the production backend (`POST /v1/control-points/evaluate`, `POST /v1/targets/register`). |
| `infrastructure/adapters/local.py` | `FireweaveLocalAdapter` — the dev substrate: seeded boolean overrides, no network. `register_target` records in-process and traces the call. |
| `infrastructure/adapters/memory.py` | Deterministic fixture-driven adapter for tests. |
| `infrastructure/hosts.py` | SSRF allowlist (on by default; https required off-loopback). |
| `start/` | The opt-in start profile (`from fireweave.start import start, fw, define_control_points`). Built on the public `fireweave` API only; `start/_env.py` is the one file that reads the environment or the host name. The core never imports it. |

## Development

```bash
python -m venv .venv && .venv/bin/pip install -e '.[dev]'
# or: uv sync
.venv/bin/pytest    # unit tests
```

`conformance/surface/control-points.surface.json` is the parity gate this package satisfies.

## License

[MIT](./LICENSE).
