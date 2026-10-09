//! Every name the start profile reads, in one place, so the README, the
//! initialise skill and the error messages cannot drift apart (node:
//! `src/start/names.ts`, go: `fw/names.go`).

/// Env vars the start profile reads. Explicit [`super::StartOptions`]
/// fields always win.
pub(crate) const ENV_KEY: &str = "FIREWEAVE_KEY";
pub(crate) const ENV_URL: &str = "FIREWEAVE_URL";
pub(crate) const ENV_ENVIRONMENT: &str = "FIREWEAVE_ENV";
pub(crate) const ENV_INSTANCE_ID: &str = "FIREWEAVE_INSTANCE_ID";

/// Legacy names written by the scaffolded harness. Read only when the
/// replacement is unset, with one warning per name, for the whole 2.x line
/// (`docs/versioning.md`: documented configuration is removed only in a
/// major).
pub(crate) const LEGACY_KEY_NAMES: [&str; 1] = ["FW_PROJECT_API_KEY"];
pub(crate) const LEGACY_URL_NAMES: [&str; 2] = ["FW_API_URL", "FW_ATTEST_URL"];

/// Read after `StartOptions.environment` and `FIREWEAVE_ENV`. `NODE_ENV` is
/// not a Rust convention and `ENV`/`RUST_ENV` are not read: only names an
/// operator sets on purpose select a mode. `cfg!(debug_assertions)` is never
/// consulted, because debug builds get deployed.
pub(crate) const ENVIRONMENT_FALLBACKS: [&str; 1] = ["APP_ENV"];

/// Read only to explain a start error: the scaffolded harness's `FW_ENV` is
/// no longer honoured.
pub(crate) const RETIRED_ENVIRONMENT_NAME: &str = "FW_ENV";

/// Environment names that mean "local development" when no key is set.
/// Compared trimmed and case-insensitively.
pub(crate) const DEV_ENVIRONMENTS: [&str; 4] = ["development", "dev", "local", "test"];

/// fw-server host for each release channel of this crate. Both are in the
/// core's default allowlist (`DEFAULT_ALLOWED_HOSTS`), so the default
/// endpoint needs no custom allowlist.
pub(crate) const PRODUCTION_URL: &str = "https://app-server.fireweave.ai";
pub(crate) const STAGING_URL: &str = "https://staging-app-server.fireweave.ai";

/// Always allowed beside a custom endpoint, so local stacks keep working.
pub(crate) const LOOPBACK_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "::1"];

/// Where the app's control points conventionally live; named in the local-mode
/// "missing key" warning.
pub(crate) const CONTROL_POINTS_FILE: &str = "src/fireweave_control_points.rs";

/// Option names as they appear in messages.
pub(crate) const OPT_KEY: &str = "StartOptions.key";
pub(crate) const OPT_URL: &str = "StartOptions.url";
pub(crate) const OPT_ENVIRONMENT: &str = "StartOptions.environment";
pub(crate) const OPT_INSTANCE_ID: &str = "StartOptions.instance_id";
