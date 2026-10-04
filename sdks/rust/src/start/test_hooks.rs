//! Test hooks for the shared start-profile suite (`contracts/start/`), driven
//! by `tests/start_contracts.rs`. Hidden from the docs and not part of the
//! supported API: they expose the pure resolver and the instance-key
//! derivation, which are crate-private, with the build channel and the host
//! name injected. Reading the fixtures and writing the report need
//! `std::fs` and `serde_json`, which `tests/start_guards.rs` keeps out of
//! `src/start/`, so the runner itself is an integration test.

use crate::{FireweaveError, Mode};

use super::channel::{sdk_version, Channel};
use super::env::lookup_from;
use super::instance::derive_instance_key;
use super::options::{EnvFn, StartOptions};
use super::resolve::{resolve, BuildInfo};

/// One resolution as the suite compares it. Never carries the key.
#[doc(hidden)]
#[derive(Debug, Clone)]
pub struct ResolvedForTests {
    pub mode: Mode,
    pub mode_source: &'static str,
    pub url: Option<String>,
    pub url_source: Option<String>,
    pub allowed_hosts: Option<Vec<String>>,
    pub key_source: String,
    pub environment: Option<String>,
    pub environment_source: Option<String>,
    pub warnings: Vec<String>,
}

/// Runs the start profile's pure resolver as if this crate build came from
/// `channel`. Reads `options.env` (the process environment when `None`);
/// no I/O otherwise.
#[doc(hidden)]
pub fn resolve_for_tests(
    options: &StartOptions,
    channel: Channel,
) -> Result<ResolvedForTests, FireweaveError> {
    let lookup = lookup_from(options.env.as_ref());
    let build = BuildInfo {
        version: sdk_version().to_string(),
        channel,
    };
    let r = resolve(options, &*lookup, &build)?;
    Ok(ResolvedForTests {
        mode: r.mode,
        mode_source: r.mode_source,
        url: r.url,
        url_source: r.url_source,
        allowed_hosts: r.allowed_hosts,
        key_source: r.key_source,
        environment: r.environment,
        environment_source: r.environment_source,
        warnings: r.warnings,
    })
}

/// `instance_key()`'s derivation with the host name injected (`None`: the
/// host name is unavailable). Reads `env` (the process environment when
/// `None`).
#[doc(hidden)]
pub fn derive_instance_key_for_tests(
    instance_id: Option<&str>,
    env: Option<&EnvFn>,
    host_name: Option<&str>,
) -> String {
    let lookup = lookup_from(env);
    let host = || host_name.map(str::to_string);
    derive_instance_key(instance_id, &*lookup, &host).0
}
