# fireweave (Rust SDK)

Fireweave release-engineering SDK for Rust — **control points** and target
registration, the two v1 capabilities (spec/control-points.md "Scope of v1").

- **Dependency budget: `ureq` (HTTP) + `serde`/`serde_json` (JSON).** Nothing
  else in `[dependencies]` — a single dependency-budget guard test asserts it
  (`tests/architecture_guard.rs`).
- **Blocking, synchronous.** Like the Python SDK — no async runtime.
- **The core reads no environment variables** — every option is an explicit
  field on `InitOptions` (spec/modes.md). The opt-in start profile
  (`fireweave::start`, below) is the one documented exception.
- **No vendor SDK, key, or hostname in your process.** Applications hold a
  Fireweave project key and talk to fw-server; which backend fw-server
  forwards to is fw-server's concern.

## Install

```bash
cargo add fireweave@3          # stable: the latest 3.x from crates.io, recorded as "3"
```

**Staging builds** are `X.Y.Z-rc.N` and call `staging-app-server.fireweave.ai`. crates.io never
receives one, so a staging build comes from its git tag, the highest `rust/vX.Y.Z-rc.N`:

```bash
cargo add fireweave --git https://github.com/FireWeave-HQ/fireweave-sdk --tag rust/v3.0.0-rc.1
```

This is the one Rust install that records an exact build: Cargo pins the tag. To move to a newer
staging build, run the command again with the higher `rust/v…-rc.N` tag.

## Quick start (one line: the start profile)

Most apps need only this ([ADR-0012](../../docs/adr/0012-start-profile.md)). The
`fireweave::start` module is an opt-in layer over the unchanged core: one control-points file, one
call in `main`, then reads from anywhere. It adds no dependency.

```rust
// src/fireweave_control_points.rs: every control point the app reads, with its local value
use fireweave::start::{define_control_points, LocalControlPoint, LocalControlPoints};

pub fn control_points() -> LocalControlPoints {
    define_control_points([
        ("new-checkout", LocalControlPoint::local(true).describe("new checkout flow")), // served only in local mode
    ])
}
```

```rust
// src/main.rs: first thing in main, after the app's own config loading (and any .env loader)
use fireweave::start::StartOptions;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    fireweave::start::start(StartOptions { control_points: fireweave_control_points::control_points(), ..Default::default() })?;
    serve();
    fireweave::start::shutdown();
    Ok(())
}
```

```rust
// any call site: the core's nine read methods, unchanged
use fireweave::EvaluationContext;

let ctx = EvaluationContext::new().with_targeting_key(&user.id);
// @fireweave-controlpoint new-checkout
if fireweave::start::control_points().get_boolean_value("new-checkout", false, Some(&ctx)) { /* … */ }

let _ = fireweave::start::identify(&user.id, [("plan", user.plan.as_str())]); // at sign-in

let me = EvaluationContext::new().with_targeting_key(fireweave::start::instance_key());
fireweave::start::control_points().get_boolean_value("nightly-reindex", false, Some(&me)); // server as subject
```

Deployed environments set one variable, `FIREWEAVE_KEY` (the project key, `project-api-key_…`).
Local development needs nothing when `FIREWEAVE_ENV` (or `APP_ENV`) is `development`, `dev`,
`local` or `test`. Rust does not load `.env` files: call your loader (e.g. `dotenvy`) before
`start`, or set the variable for `cargo run`/`cargo test` only in `.cargo/config.toml` at the
workspace root (the deployed binary never sees it, and a real env var overrides it):

```toml
[env]
FIREWEAVE_ENV = "development"
```

### Options and overrides

Every value resolves as: `StartOptions` field, then env var, then legacy name (warns once), then
default. Empty and whitespace-only values count as unset.

| Option | Env var | Default | What it does |
| --- | --- | --- | --- |
| `control_points` | — | none | Local values per control point (`define_control_points`). Ignored in remote mode. |
| `mode` | — | inferred | `Some(Mode::Remote)` or `Some(Mode::Local)`. Overrides inference. Remote without a key is a start error; local ignores a key (one warning). |
| `environment` | `FIREWEAVE_ENV`, `APP_ENV` | — | Environment name used for inference when there is no key and no `mode`. Pass your own, e.g. a deploy-stage setting. `NODE_ENV` and `FW_ENV` are not read, and debug builds are never treated as development. |
| `url` | `FIREWEAVE_URL` (legacy `FW_API_URL`, `FW_ATTEST_URL`) | from the crate version | A `-rc.N` crate version calls `staging-app-server.fireweave.ai`; any other calls `app-server.fireweave.ai`. Set it for a self-hosted or local fw-server: https is required except on localhost, and the allowlist becomes that host plus loopback. |
| `key` | `FIREWEAVE_KEY` (legacy `FW_PROJECT_API_KEY`) | — | Project key. Pass it to read from your own secret store. Browser keys, analytics vendor keys and org/CLI tokens are rejected at start, naming the source, never the value. |
| `instance_id` | `FIREWEAVE_INSTANCE_ID` | `inst_` + hash of the host name | Value of `instance_key()`, the same key every FireWeave SDK derives on that host. Nothing is written to disk. Set it when replicas share a host name. |
| `env` | — | the process | `Arc<dyn Fn(&str) -> Option<String>>` read instead of the process environment (tests, apps with their own config source); `env_map([...])` builds one from pairs. Return `None` for unset; apply no defaults. |
| `log` | — | standard error | `Arc<dyn Fn(&str)>` receiving `[fireweave]` lines (warnings, the local-mode line, the local `register_target` trace). Route it into your logger. |

The channel comes from the crate version Cargo compiled into your build:
`fireweave::start::sdk_version()` and `sdk_channel()` report it.

The host name is read with std only (Rust has no `gethostname` without a dependency):
`/proc/sys/kernel/hostname`, then `HOSTNAME`, `COMPUTERNAME`, `/etc/hostname`. Where none exists
(macOS without an exported `HOSTNAME`), `instance_key()` is random for the process, with one
warning: set `FIREWEAVE_INSTANCE_ID` there.

**Mode rule.** `mode` wins. Otherwise: a key means remote. No key and a development environment
name means local. Anything else (including no environment name at all) is a `Configuration`
`FireweaveError` from `start` naming `FIREWEAVE_KEY`, so a deploy that forgot its key fails
instead of silently serving defaults.

**Reads never fail.** If start failed, reads return your default (`*_details` return an `ERROR`
decision carrying the start error). `start` is synchronous and does no network I/O; a second
call with the same configuration is a no-op, and a different one returns a `Configuration`
error. A read before `start` starts FireWeave from the environment alone (once, on that read),
so call `start` first in `main`. `fireweave::start::client()` is one `&'static FireweaveClient`
for the life of the process, safe to take before `start` and to inject; shut down with
`fireweave::start::shutdown()` (never `client().shutdown()`), after which reads serve defaults
until a new `start`.

**Async.** Remote reads and `identify` are blocking HTTP calls (3 s timeout; `identify` retries
once). Inside an async handler, run them in `tokio::task::spawn_blocking` (or actix's
`web::block`) and fall back to the default on a join error.

**Debugging.** `fireweave::start::status()` reports the state, mode and why (`option`, `key` or
`environment`), channel, SDK version, host, endpoint source, key source, environment name, flag
count, the start error and `last_error_kind`. It never contains the key, so it is safe to log:

```rust
eprintln!("fireweave: {:?}", fireweave::start::status());
```

Reads never fail, so a key fw-server refuses would otherwise look like a rollout at 0%. When
fw-server rejects the key (401 `Authentication`, 403 `Authorization`), rate-limits it (429
`RateLimited`) or cannot be reached (`Network`, `Timeout`, `BackendUnavailable`), the start
profile logs one line per kind for the life of the process through your `log` sink (standard
error by default), naming the key's source (for example `FIREWEAVE_KEY`) or the fw-server host and
never the key, and `status().last_error_kind` reports the latest of them. Every message and line
passes `fireweave::redact_secrets`, which implements `rules.redaction` in `contracts/errors.json`.

## Quick start (production path)

```rust
use fireweave::{init_fireweave, EvaluationContext, InitOptions, RegisterTargetOptions};

// mode is required and never inferred (spec/modes.md); api_key/api_url are
// explicit fields — the SDK reads no environment variables.
let client = init_fireweave(InitOptions::remote(
    "project-api-key_...",
    "https://app-server.fireweave.ai",
)).unwrap();

// Once per login: the durable facts your targeting rules match on.
let properties = serde_json::json!({ "plan": "pro" }).as_object().unwrap().clone();
client.register_target(
    "user_42",
    Some(&RegisterTargetOptions { properties: Some(properties), ..Default::default() }),
);

// Per request.
let ctx = EvaluationContext::new().with_targeting_key("user_42");
let enabled = client.control_points.get_boolean_value("new-checkout", false, Some(&ctx));

client.shutdown();
```

## Quick start (offline, in-memory)

```rust
use fireweave::{FireweaveClient, FireweaveRuntime, InMemoryAdapter, RuntimeConfig};
use std::sync::Arc;

let adapter = InMemoryAdapter::new(
    serde_json::json!({
        "new-checkout": { "type": "boolean", "enabled": true, "variant": "on", "value": true }
    })
    .as_object()
    .unwrap()
    .clone(),
);
let runtime = Arc::new(FireweaveRuntime::new(Box::new(adapter), RuntimeConfig::default()));
runtime.initialize().unwrap();
let client = FireweaveClient::new(runtime);

assert!(client.control_points.get_boolean_value("new-checkout", false, None));
client.shutdown();
```

## Quick start (local dev — no network, no credentials)

```rust
use fireweave::{init_fireweave, InitOptions};
use std::collections::HashMap;

let mut control_points = HashMap::new();
control_points.insert("new-checkout".to_string(), true);
let client = init_fireweave(InitOptions::local_with_control_points(control_points)).unwrap();
assert!(client.control_points.get_boolean_value("new-checkout", false, None));
client.register_target("user_42", None); // recorded in-process + traced; nothing sent
client.shutdown();
```

The recorded target set is readable back (`spec/modes.md`: "The recorded
set MUST be readable ... so tests can assert registration without
capturing stdout") by downcasting the runtime's adapter — the same pattern
node/go/java's own test suites use on their equivalent `runtime.adapter`
accessor:

```rust
use fireweave::{init_fireweave, FireweaveLocalAdapter, InitOptions};

let client = init_fireweave(InitOptions::local()).unwrap();
client.register_target("user_42", None);

let local_adapter = client
    .runtime()
    .adapter()
    .as_any()
    .downcast_ref::<FireweaveLocalAdapter>()
    .expect("local mode is always backed by FireweaveLocalAdapter");
assert_eq!(local_adapter.registered_targets()[0].targeting_key, "user_42");
```

## The nine methods

`get_boolean_value` / `get_string_value` / `get_number_value` /
`get_object_value`, their `*_details` counterparts (return the whole
`Decision` — `reason`, `error_kind`, `control_point_metadata`, ... — instead of
just the value), and the general-form `evaluate`. All nine live on
`client.control_points`; the `client.flags()` alias was removed in 3.0.0
(ADR-0013).

## Module layout

| Module | Responsibility |
| --- | --- |
| `domain/` | Pure types + validation: `errors.rs`, `types.rs`, `context.rs`, `decision.rs`, `mode.rs`, `target.rs`, `validation.rs`. No I/O, no imports from `application::`/`infrastructure::`. |
| `application/runtime.rs` | Lifecycle state machine, context layering, the evaluation pipeline. Evaluation never panics. |
| `application/client.rs` | `FireweaveClient` — `control_points`, `register_target`, `invoke_capability` (degrades; v1 has no supported capabilities). |
| `application/mode.rs` | `init_fireweave` — the single entry point and sanctioned composition root (the only file allowed to import concrete adapters). |
| `application/ports.rs` | The `BackendAdapter` trait boundary + `AsAny` (checked downcast back to a concrete adapter, e.g. `FireweaveLocalAdapter`). |
| `infrastructure/adapters/remote.rs` | `FireweaveRemoteAdapter` — the production backend (`POST /v1/control-points/evaluate`, `POST /v1/targets/register`) over `ureq`. |
| `infrastructure/adapters/local.rs` | `FireweaveLocalAdapter` — the dev substrate: seeded boolean overrides, no network. `register_target` records in-process and traces the call. |
| `infrastructure/adapters/memory.rs` | Deterministic fixture-driven adapter for tests. |
| `infrastructure/hosts.rs` | SSRF allowlist (on by default; https required off-loopback). |

## Development

```bash
cargo build
cargo test           # unit + doctests + architecture/surface guard tests
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cargo run --bin conformance -- --contracts ../../contracts --out /tmp/report.json
```

## License

[MIT](../../LICENSE).
