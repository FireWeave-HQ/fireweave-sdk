//! Fireweave SDK for Rust (spec v0.1.0).
//!
//! Exactly two v1 capabilities (`spec/control-points.md` "Scope of v1"):
//! control points and target registration. Dependency budget: `ureq`
//! (HTTP client) + `serde`/`serde_json` (JSON) — nothing else in
//! `[dependencies]`.
//!
//! Quick start (in-memory, offline):
//!
//! ```
//! use fireweave::{FireweaveClient, FireweaveRuntime, InMemoryAdapter, RuntimeConfig};
//! use std::sync::Arc;
//!
//! let adapter = InMemoryAdapter::new(Default::default());
//! let runtime = Arc::new(FireweaveRuntime::new(Box::new(adapter), RuntimeConfig::default()));
//! runtime.initialize().unwrap();
//! let client = FireweaveClient::new(runtime);
//! assert_eq!(client.control_points.get_boolean_value("my-flag", false, None), false);
//! client.shutdown();
//! ```
//!
//! Or, through the single entry point (`spec/modes.md`):
//!
//! ```
//! use fireweave::{init_fireweave, InitOptions};
//! use std::collections::HashMap;
//!
//! let mut control_points = HashMap::new();
//! control_points.insert("my-flag".to_string(), true);
//! let client = init_fireweave(InitOptions::local_with_control_points(control_points)).unwrap();
//! assert!(client.control_points.get_boolean_value("my-flag", false, None));
//! client.shutdown();
//! ```
//!
//! There are no hidden global clients: everything is constructed
//! explicitly and injectable for tests.

pub mod application;
pub mod domain;
pub mod infrastructure;

/// Package version (`Cargo.toml`'s `[package].version`).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Frozen SDK spec version this crate implements (`spec/version.json`).
pub const SPEC_VERSION: &str = "0.1.0";

// -- runtime / client / entry point ------------------------------------------
pub use application::client::{ControlPointsNamespace, ExtensionResult, FireweaveClient};
pub use application::mode::{init_fireweave, InitOptions};
pub use application::ports::{
    AsAny, BackendAdapter, EvaluateOptions, FlagResolution, RegisterTargetOptions,
    RegisterTargetResult,
};
pub use application::runtime::{
    FireweaveRuntime, LifecycleState, RuntimeConfig, DEFAULT_SHUTDOWN_TIMEOUT_MS,
};

// -- adapters -----------------------------------------------------------------
pub use infrastructure::adapters::local::{FireweaveLocalAdapter, LocalRegisteredTarget};
pub use infrastructure::adapters::memory::{FlagDefinition, InMemoryAdapter, InMemoryFault};
pub use infrastructure::adapters::remote::{FireweaveRemoteAdapter, RemoteAdapterConfig};
pub use infrastructure::hosts::{assert_host_allowed, is_loopback_hostname, DEFAULT_ALLOWED_HOSTS};

// -- context ------------------------------------------------------------------
pub use domain::context::{
    merge_contexts, ContextLimits, EvaluationContext, ALLOWED_FIREWEAVE_CONTEXT_KEYS,
    DEFAULT_CONTEXT_LIMITS, DEFAULT_RESERVED_ATTRIBUTE_KEYS,
};

// -- decisions / types ----------------------------------------------------------
pub use domain::decision::{reason, Decision};
pub use domain::mode::Mode;
pub use domain::target::TargetKind;
pub use domain::types::{FlagMetadata, FlagType, JsonValue};

// -- validation -----------------------------------------------------------------
pub use domain::validation::{
    matches_expected_type, validate_context, validate_control_point_key, validate_default_value,
    validate_init_options, validate_targeting_key,
};

// -- errors -----------------------------------------------------------------------
pub use domain::errors::{redact_secrets, ErrorKind, FireweaveError, FLAG_METADATA_ERROR_KIND_KEY};
