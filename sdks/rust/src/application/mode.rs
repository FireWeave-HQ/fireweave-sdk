//! `init_fireweave` — the single SDK entry point (`spec/modes.md`).
//!
//! `mode` is required and never inferred: a missing or mistyped credential
//! must fail loudly at boot, not silently fall back to local evaluation —
//! that failure mode looks like a green boot and a feature that never
//! ramps. This module's only job is to validate the initialisation-time
//! contract and select the matching adapter; nothing downstream branches
//! on mode again (`spec/modes.md` "Behaviour per mode" — both adapters
//! implement the same `BackendAdapter` port, so `FireweaveClient`/
//! `FireweaveRuntime` stay mode-blind).
//!
//! Initialisation fails loudly (`Err`); reads on the returned client never
//! do (`spec/control-points.md` "initialise is the exception"). The
//! validation itself lives in `domain::validation::validate_init_options`,
//! which returns a plain `Result` like every other validator — this
//! module is what surfaces a failed validation as the `Err`
//! `spec/modes.md` requires.
//!
//! This is the SANCTIONED composition root (mirrors node's
//! `application/mode.ts` / go's `application/mode.go` / java's
//! `application/InitOptions.java` + `Fireweave.init`): the only file under
//! `application/` allowed to import concrete `infrastructure::adapters::*`
//! (`tests/architecture_guard.rs`).

use std::collections::HashMap;
use std::sync::Arc;

use crate::domain::errors::FireweaveError;
use crate::domain::mode::Mode;
use crate::domain::validation::validate_init_options;
use crate::infrastructure::adapters::local::{FireweaveLocalAdapter, LogSink};
use crate::infrastructure::adapters::remote::{FireweaveRemoteAdapter, RemoteAdapterConfig};
use crate::infrastructure::hosts::assert_host_allowed;

use super::client::FireweaveClient;
use super::runtime::{FireweaveRuntime, RuntimeConfig};

/// Options for [`init_fireweave`], mirroring node's
/// `InitFireweaveOptions` / python's `init_fireweave(**options)`
/// (`spec/modes.md`).
///
/// Local- and remote-mode fields live on the SAME struct rather than two
/// disjoint types, deliberately: `spec/modes.md`'s initialisation-
/// validation table has a row for "`mode: 'local'` with credentials
/// supplied" (a config half-migrated from remote to local reads as
/// neither, silently, unless rejected) — that row is only reachable when a
/// caller CAN construct a value carrying both a mode and left-over
/// credentials, which two disjoint types would prevent by construction
/// (mirrors go's `application.Options` / java's `InitOptions`, built for
/// the identical reason).
#[derive(Default)]
pub struct InitOptions {
    /// `None` is the reachable "mode absent" row
    /// (`domain::mode::Mode`'s doc comment explains why "mode
    /// unrecognised" has no Rust analogue).
    pub mode: Option<Mode>,

    /// Remote mode (`spec/modes.md`): required, never read from env.
    pub api_key: Option<String>,
    pub api_url: Option<String>,
    /// SSRF allowlist override (`spec/modes.md` "apiUrl fails the host
    /// allowlist"). `None` means the canonical default
    /// (`infrastructure::hosts::DEFAULT_ALLOWED_HOSTS`).
    pub allowed_hosts: Option<Vec<String>>,
    pub request_timeout_ms: Option<u64>,

    /// Local mode (`spec/modes.md`): optional; empty behaves like an empty
    /// seed map.
    pub control_points: HashMap<String, bool>,
    /// Sink for the `[fireweave:local]` `registerTarget` trace line
    /// (`spec/modes.md` "registerTarget in local mode", local mode only).
    /// `None` means the adapter's own default (`eprintln!`).
    pub log: Option<LogSink>,
}

impl InitOptions {
    /// Evaluate against fw-server over the network (`spec/remote-protocol.md`).
    pub fn remote(api_key: impl Into<String>, api_url: impl Into<String>) -> Self {
        InitOptions {
            mode: Some(Mode::Remote),
            api_key: Some(api_key.into()),
            api_url: Some(api_url.into()),
            ..Default::default()
        }
    }

    /// Evaluate against an in-process seeded map; no network (`spec/modes.md`).
    pub fn local() -> Self {
        InitOptions {
            mode: Some(Mode::Local),
            ..Default::default()
        }
    }

    /// Evaluate against an in-process seeded map; no network (`spec/modes.md`).
    pub fn local_with_control_points(control_points: HashMap<String, bool>) -> Self {
        InitOptions {
            mode: Some(Mode::Local),
            control_points,
            ..Default::default()
        }
    }

    pub fn with_allowed_hosts(mut self, hosts: Vec<String>) -> Self {
        self.allowed_hosts = Some(hosts);
        self
    }

    pub fn with_request_timeout_ms(mut self, ms: u64) -> Self {
        self.request_timeout_ms = Some(ms);
        self
    }

    pub fn with_log(mut self, log: impl Fn(&str) + Send + Sync + 'static) -> Self {
        self.log = Some(Box::new(log));
        self
    }
}

fn init_local(options: InitOptions) -> Result<FireweaveClient, FireweaveError> {
    let adapter = FireweaveLocalAdapter::new(options.control_points, options.log);
    let runtime = Arc::new(FireweaveRuntime::new(
        Box::new(adapter),
        RuntimeConfig::default(),
    ));
    runtime.initialize()?;
    Ok(FireweaveClient::new(runtime))
}

fn init_remote(options: InitOptions) -> Result<FireweaveClient, FireweaveError> {
    let api_key = options.api_key.unwrap_or_default();
    let api_url = options.api_url.unwrap_or_default();
    // `validate_init_options` (called by `init_fireweave`, below) has
    // already ruled out blank api_key/api_url by the time this runs — only
    // the host allowlist row remains to check here (`spec/modes.md`
    // "apiUrl fails the host allowlist"), against the CANONICAL default
    // allowlist when the caller supplies no override. This is the
    // sanctioned entry point's gate; the adapter's own `initialize()`
    // carries a second, more permissive check (its own hostname
    // self-allowed) as a safety net for direct adapter construction that
    // bypasses `init_fireweave` entirely.
    assert_host_allowed(&api_url, options.allowed_hosts.as_deref(), true)?;

    let adapter = FireweaveRemoteAdapter::new(RemoteAdapterConfig {
        api_url,
        api_key,
        allowed_hosts: options.allowed_hosts,
        request_timeout_ms: options.request_timeout_ms.unwrap_or(3000),
    });
    let runtime = Arc::new(FireweaveRuntime::new(
        Box::new(adapter),
        RuntimeConfig::default(),
    ));
    runtime.initialize()?;
    Ok(FireweaveClient::new(runtime))
}

/// Builds the adapter matching `options.mode` and brings a
/// [`FireweaveClient`] to READY.
///
/// Returns `Err(FireweaveError { kind: Configuration, .. })` for every row
/// of the initialisation-validation table (`spec/modes.md`) this Rust SDK
/// can represent:
///
/// - `mode` absent (`None`)
/// - `mode: Remote` with `api_key`/`api_url` missing/blank
/// - `api_url` fails the host allowlist
/// - `mode: Local` with credentials supplied
///
/// The first, second and fourth rows are `validate_init_options`'s job;
/// the third is validated in `init_remote`, before any adapter/network I/O
/// happens.
///
/// ```
/// use fireweave::{init_fireweave, InitOptions};
///
/// let client = init_fireweave(InitOptions::local()).unwrap();
/// assert_eq!(client.control_points.get_boolean_value("my-flag", false, None), false);
/// client.shutdown();
/// ```
pub fn init_fireweave(options: InitOptions) -> Result<FireweaveClient, FireweaveError> {
    validate_init_options(
        options.mode,
        options.api_key.as_deref(),
        options.api_url.as_deref(),
    )?;
    match options
        .mode
        .expect("validate_init_options already rejected a None mode")
    {
        Mode::Local => init_local(options),
        Mode::Remote => init_remote(options),
    }
}
