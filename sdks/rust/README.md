# fireweave (Rust SDK)

Fireweave release-engineering SDK for Rust — **control points** and target
registration, the two v1 capabilities (spec/control-points.md "Scope of v1").

- **Dependency budget: `ureq` (HTTP) + `serde`/`serde_json` (JSON).** Nothing
  else in `[dependencies]` — a single dependency-budget guard test asserts it
  (`tests/architecture_guard.rs`).
- **Blocking, synchronous.** Like the Python SDK — no async runtime.
- **The SDK reads no environment variables** — every option is an explicit
  field on `InitOptions` (spec/modes.md).
- **No vendor SDK, key, or hostname in your process.** Applications hold a
  Fireweave project key and talk to fw-server; which backend fw-server
  forwards to is fw-server's concern.

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

## The nine methods

`get_boolean_value` / `get_string_value` / `get_number_value` /
`get_object_value`, their `*_details` counterparts (return the whole
`Decision` — `reason`, `error_kind`, `flag_metadata`, ... — instead of just
the value), and the general-form `evaluate`. All nine live on
`client.control_points`; `client.flags()` is an identical, fully-supported
alias returning a reference to the same field
(`std::ptr::eq(&client.control_points, client.flags())` holds).

## Module layout

| Module | Responsibility |
| --- | --- |
| `domain/` | Pure types + validation: `errors.rs`, `types.rs`, `context.rs`, `decision.rs`, `mode.rs`, `target.rs`, `validation.rs`. No I/O, no imports from `application::`/`infrastructure::`. |
| `application/runtime.rs` | Lifecycle state machine, context layering, the evaluation pipeline. Evaluation never panics. |
| `application/client.rs` | `FireweaveClient` — `control_points`, `register_target`, `invoke_capability` (degrades; v1 has no supported capabilities). |
| `application/mode.rs` | `init_fireweave` — the single entry point and sanctioned composition root (the only file allowed to import concrete adapters). |
| `application/ports.rs` | The `BackendAdapter` trait boundary. |
| `infrastructure/adapters/remote.rs` | `FireweaveRemoteAdapter` — the production backend (`POST /v1/flags/evaluate`, `POST /v1/targets/register`) over `ureq`. |
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
