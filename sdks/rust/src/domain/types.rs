//! Shared public types for the Fireweave SDK.
//!
//! No vendor-backend or OpenFeature-provider types appear here — these are
//! the canonical Fireweave-owned shapes per spec/ v0.1.0.

/// JSON-compatible value (`spec/decision.schema.json` `$defs.jsonValue`).
///
/// `serde_json::Value` already distinguishes `Bool` from `Number` as
/// separate enum variants, so — unlike Python, where `bool` is a subclass
/// of `int` and needs an explicit carve-out in `matches_expected_type` —
/// Rust has no analogous "a boolean default accidentally matches NUMBER"
/// hazard to guard against.
pub type JsonValue = serde_json::Value;

/// `flagMetadata` values per `spec/decision.schema.json`: `bool | string | number`.
///
/// `serde_json::Map`'s default (no `preserve_order` feature) backing store
/// is a `BTreeMap`, so keys serialize in sorted order — exactly the
/// deterministic ordering `spec/decision.schema.json`'s `fireweave.payload`
/// stable-JSON-string requirement needs (see
/// `application::runtime::stable_json`), with no extra dependency.
pub type FlagMetadata = serde_json::Map<String, JsonValue>;

/// Requested flag value type for typed evaluation
/// (`spec/control-points.md` "The nine methods"). Exactly four members:
/// boolean, string, number, object — there is no separate integer/float
/// distinction in v1 (`Decision.value` is `jsonValue`; `getNumberValue`
/// returns **number**, not integer).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FlagType {
    Boolean,
    String,
    Number,
    Object,
}

impl FlagType {
    /// Canonical wire spelling (`spec/control-points.md`, `contracts/`
    /// fixture `when.flagType`, modulo the runner's own
    /// `integer`/`float` -> `Number` collapse).
    pub fn as_str(&self) -> &'static str {
        match self {
            FlagType::Boolean => "boolean",
            FlagType::String => "string",
            FlagType::Number => "number",
            FlagType::Object => "object",
        }
    }
}

impl std::fmt::Display for FlagType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for FlagType {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "boolean" => Ok(FlagType::Boolean),
            "string" => Ok(FlagType::String),
            "number" => Ok(FlagType::Number),
            "object" => Ok(FlagType::Object),
            _ => Err(()),
        }
    }
}
