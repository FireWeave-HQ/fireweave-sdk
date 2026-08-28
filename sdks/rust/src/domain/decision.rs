//! Canonical evaluation decision (`spec/decision.schema.json`).

use super::errors::ErrorKind;
use super::types::{FlagMetadata, JsonValue};

/// Canonical reason strings (`spec/decision.schema.json`).
pub mod reason {
    pub const TARGETING_MATCH: &str = "TARGETING_MATCH";
    pub const SPLIT: &str = "SPLIT";
    pub const DISABLED: &str = "DISABLED";
    pub const DEFAULT: &str = "DEFAULT";
    pub const STALE: &str = "STALE";
    pub const CACHED: &str = "CACHED";
    pub const STATIC: &str = "STATIC";
    pub const ERROR: &str = "ERROR";
}

/// Result of a flag evaluation. Evaluation APIs return this, never raise
/// (`spec/control-points.md` "Return discipline — never throw into a read
/// path").
#[derive(Debug, Clone, PartialEq)]
pub struct Decision {
    pub value: JsonValue,
    pub variant: Option<String>,
    pub reason: String,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub error_kind: Option<ErrorKind>,
    pub flag_metadata: FlagMetadata,
}

impl Decision {
    /// A decision degraded to the caller's default with a no-frills reason
    /// (e.g. `DEFAULT`/`STATIC`) and no error.
    pub fn new(value: JsonValue, variant: Option<String>, reason: impl Into<String>) -> Self {
        Decision {
            value,
            variant,
            reason: reason.into(),
            error_code: None,
            error_message: None,
            error_kind: None,
            flag_metadata: FlagMetadata::new(),
        }
    }

    pub fn is_error(&self) -> bool {
        self.reason == reason::ERROR
    }
}
