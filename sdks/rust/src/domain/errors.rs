//! Fireweave canonical error taxonomy (`spec/errors.schema.json`, 15 kinds).
//!
//! Rules implemented here:
//!
//! - **Defaults do not throw**: the runtime converts these errors into
//!   default-valued decisions; control-point reads never raise for abnormal
//!   evaluation (`spec/control-points.md` "Return discipline"). In Rust
//!   terms: `FireweaveError` is returned from fallible internals
//!   (`Result<_, FireweaveError>`), never from a read-path public method —
//!   only `init_fireweave` surfaces it as an `Err`.
//! - **No secrets in messages**: every message that crosses the
//!   `FireweaveError` constructor runs through [`redact_secrets`]; canonical
//!   default messages never echo credentials in the first place.
//!
//! The `openfeature_error_code` vocabulary is the wire vocabulary fixed by
//! `spec/errors.schema.json` (mirrors OpenFeature's ErrorCode strings);
//! carrying it is not "exposing an OpenFeature provider"
//! (`spec/control-points.md` "Scope of v1" forbids the latter, not the
//! shared error-code spelling).

/// `flagMetadata` key carrying the canonical Fireweave kind on error
/// decisions (`spec/errors.schema.json` `rules.flagMetadataErrorKindKey`).
pub const FLAG_METADATA_ERROR_KIND_KEY: &str = "fireweave.errorKind";

/// Canonical PascalCase error kinds (`spec/errors.schema.json`); exactly 15.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorKind {
    NotReady,
    FlagNotFound,
    TypeMismatch,
    InvalidContext,
    Authentication,
    Authorization,
    RateLimited,
    Timeout,
    Network,
    BackendUnavailable,
    MalformedResponse,
    UnsupportedCapability,
    Configuration,
    AlreadyClosed,
    Internal,
}

impl ErrorKind {
    /// Canonical PascalCase wire spelling.
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorKind::NotReady => "NotReady",
            ErrorKind::FlagNotFound => "FlagNotFound",
            ErrorKind::TypeMismatch => "TypeMismatch",
            ErrorKind::InvalidContext => "InvalidContext",
            ErrorKind::Authentication => "Authentication",
            ErrorKind::Authorization => "Authorization",
            ErrorKind::RateLimited => "RateLimited",
            ErrorKind::Timeout => "Timeout",
            ErrorKind::Network => "Network",
            ErrorKind::BackendUnavailable => "BackendUnavailable",
            ErrorKind::MalformedResponse => "MalformedResponse",
            ErrorKind::UnsupportedCapability => "UnsupportedCapability",
            ErrorKind::Configuration => "Configuration",
            ErrorKind::AlreadyClosed => "AlreadyClosed",
            ErrorKind::Internal => "Internal",
        }
    }

    /// Canonical safe default message for this kind (`contracts/errors.json`).
    pub fn default_message(&self) -> &'static str {
        match self {
            ErrorKind::NotReady => "provider not ready",
            ErrorKind::FlagNotFound => "flag not found",
            ErrorKind::TypeMismatch => "flag type mismatch",
            ErrorKind::InvalidContext => "invalid evaluation context",
            ErrorKind::Authentication => "authentication failed",
            ErrorKind::Authorization => "authorization failed",
            ErrorKind::RateLimited => "rate limited",
            ErrorKind::Timeout => "request timed out",
            ErrorKind::Network => "network error",
            ErrorKind::BackendUnavailable => "backend unavailable",
            ErrorKind::MalformedResponse => "malformed backend response",
            ErrorKind::UnsupportedCapability => "unsupported capability",
            ErrorKind::Configuration => "invalid configuration",
            ErrorKind::AlreadyClosed => "provider already closed",
            ErrorKind::Internal => "internal error",
        }
    }

    /// `contracts/errors.json`: kinds that a later identical call may
    /// succeed at without a configuration change.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            ErrorKind::NotReady
                | ErrorKind::RateLimited
                | ErrorKind::Timeout
                | ErrorKind::Network
                | ErrorKind::BackendUnavailable
        )
    }

    /// Baseline OpenFeature error-code mapping (`spec/errors.schema.json`).
    /// `InvalidContext` -> `TARGETING_KEY_MISSING` and
    /// `Configuration` -> `PROVIDER_FATAL` are subtype overrides carried on
    /// [`FireweaveError`] itself, not here (see
    /// [`FireweaveError::openfeature_error_code`]).
    fn base_openfeature_error_code(&self) -> &'static str {
        match self {
            ErrorKind::NotReady => "PROVIDER_NOT_READY",
            ErrorKind::FlagNotFound => "FLAG_NOT_FOUND",
            ErrorKind::TypeMismatch => "TYPE_MISMATCH",
            ErrorKind::InvalidContext => "INVALID_CONTEXT",
            ErrorKind::Authentication => "GENERAL",
            ErrorKind::Authorization => "GENERAL",
            ErrorKind::RateLimited => "GENERAL",
            ErrorKind::Timeout => "GENERAL",
            ErrorKind::Network => "GENERAL",
            ErrorKind::BackendUnavailable => "GENERAL",
            ErrorKind::MalformedResponse => "PARSE_ERROR",
            ErrorKind::UnsupportedCapability => "GENERAL",
            // Runtime path; init-fatal overrides to PROVIDER_FATAL (see
            // FireweaveError::openfeature_error_code).
            ErrorKind::Configuration => "GENERAL",
            ErrorKind::AlreadyClosed => "PROVIDER_NOT_READY",
            ErrorKind::Internal => "GENERAL",
        }
    }
}

impl std::fmt::Display for ErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A concrete Fireweave error occurrence.
///
/// Carries the canonical `kind` and a secret-redacted `message`. Three
/// booleans thread the subtype/behavioral flags the reference SDKs model as
/// constructor keyword args (python) / dedicated struct fields (go):
///
/// - `quota_limited` — only meaningful on `FlagNotFound`: the backend
///   reported quota limiting for this evaluation
///   (`spec/decision.schema.json` `standardMetadataKeys`).
/// - `init_fatal` — only meaningful on `Configuration`: whether this
///   occurrence is on the init-fatal path (`PROVIDER_FATAL`) rather than a
///   runtime path (`GENERAL`).
/// - `targeting_key_missing` — only meaningful on `InvalidContext`: whether
///   this occurrence is specifically a missing targeting key
///   (`TARGETING_KEY_MISSING`) rather than a generic context failure
///   (`INVALID_CONTEXT`).
#[derive(Debug, Clone)]
pub struct FireweaveError {
    pub kind: ErrorKind,
    pub message: String,
    pub quota_limited: bool,
    pub init_fatal: bool,
    pub targeting_key_missing: bool,
}

impl FireweaveError {
    /// A new error of `kind`, carrying its canonical default message.
    pub fn new(kind: ErrorKind) -> Self {
        FireweaveError {
            message: redact_secrets(kind.default_message()),
            kind,
            quota_limited: false,
            init_fatal: false,
            targeting_key_missing: false,
        }
    }

    /// A new error of `kind`, carrying an explicit (redacted) message.
    pub fn with_message(kind: ErrorKind, message: impl AsRef<str>) -> Self {
        FireweaveError {
            message: redact_secrets(message.as_ref()),
            kind,
            quota_limited: false,
            init_fatal: false,
            targeting_key_missing: false,
        }
    }

    /// `FlagNotFound`, optionally noting the backend reported quota limiting
    /// (`contracts/errors.json`: "quota-limited responses resolve as
    /// FlagNotFound with fireweave.quotaLimited metadata").
    pub fn flag_not_found(quota_limited: bool) -> Self {
        let mut err = FireweaveError::new(ErrorKind::FlagNotFound);
        err.quota_limited = quota_limited;
        err
    }

    /// `InvalidContext` subtype: missing targeting key
    /// (`spec/control-points.md` "Context"). OF code `TARGETING_KEY_MISSING`.
    pub fn targeting_key_missing() -> Self {
        let mut err =
            FireweaveError::with_message(ErrorKind::InvalidContext, "targeting key missing");
        err.targeting_key_missing = true;
        err
    }

    /// `Configuration`, with `init_fatal` controlling the OF error-code
    /// subtype (`spec/modes.md` "Initialisation validation": every row here
    /// raises with `init_fatal = true`).
    pub fn configuration(message: impl AsRef<str>, init_fatal: bool) -> Self {
        let mut err = FireweaveError::with_message(ErrorKind::Configuration, message);
        err.init_fatal = init_fatal;
        err
    }

    /// Whether a later identical call may succeed without a configuration
    /// change (`contracts/errors.json`).
    pub fn retryable(&self) -> bool {
        self.kind.is_retryable()
    }

    /// OpenFeature error-code string for this occurrence, applying the two
    /// documented subtype overrides (`spec/errors.schema.json`
    /// `openFeatureErrorCodeAlternates`).
    pub fn openfeature_error_code(&self) -> &'static str {
        if self.kind == ErrorKind::InvalidContext && self.targeting_key_missing {
            return "TARGETING_KEY_MISSING";
        }
        if self.kind == ErrorKind::Configuration && self.init_fatal {
            return "PROVIDER_FATAL";
        }
        self.kind.base_openfeature_error_code()
    }
}

impl std::fmt::Display for FireweaveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

impl std::error::Error for FireweaveError {}

// ---------------------------------------------------------------------------
// Secret redaction — manual scanner, NOT a regex crate: the dependency
// budget for this SDK is exactly ureq + serde + serde_json
// (tests/architecture_guard.rs), so `spec/errors.schema.json`'s
// `secretPatterns` (`phc_`/`phs_`/`phx_`, `Bearer <token>`,
// `FW_PROJECT_API_KEY=<token>`/`FW_PROJECT_API_KEY:<token>`) are matched by
// hand rather than compiled from a pattern string. Equivalent to node/
// python's `(ph[csx]_[A-Za-z0-9_\-]*|Bearer\s+\S+|FW_PROJECT_API_KEY\s*[=:]
// \s*\S+)` regex, byte-for-byte on the covered cases.
// ---------------------------------------------------------------------------

const SECRET_KEY_PREFIXES: [&str; 3] = ["phc_", "phs_", "phx_"];

fn consume_while(s: &str, pred: impl Fn(char) -> bool) -> usize {
    let mut n = 0;
    for ch in s.chars() {
        if pred(ch) {
            n += ch.len_utf8();
        } else {
            break;
        }
    }
    n
}

/// Matches a `phc_`/`phs_`/`phx_` prefix (case-sensitive, matching the
/// reference regex) followed by zero or more `[A-Za-z0-9_-]` characters.
/// Returns the byte length of the whole match, if `rest` starts with one.
fn match_project_key_prefix(rest: &str) -> Option<usize> {
    let prefix = SECRET_KEY_PREFIXES.iter().find(|p| rest.starts_with(**p))?;
    let mut end = prefix.len();
    end += consume_while(&rest[end..], |c| {
        c.is_ascii_alphanumeric() || c == '_' || c == '-'
    });
    Some(end)
}

/// Matches `Bearer` + required whitespace run + required non-whitespace
/// run (`Bearer\s+\S+`).
fn match_bearer_token(rest: &str) -> Option<usize> {
    const KEYWORD: &str = "Bearer";
    if !rest.starts_with(KEYWORD) {
        return None;
    }
    let mut idx = KEYWORD.len();
    let ws = consume_while(&rest[idx..], char::is_whitespace);
    if ws == 0 {
        return None;
    }
    idx += ws;
    let token = consume_while(&rest[idx..], |c| !c.is_whitespace());
    if token == 0 {
        return None;
    }
    idx += token;
    Some(idx)
}

/// Matches `FW_PROJECT_API_KEY` + optional whitespace + (`=` or `:`) +
/// optional whitespace + required non-whitespace run
/// (`FW_PROJECT_API_KEY\s*[=:]\s*\S+`).
fn match_fw_project_api_key_assignment(rest: &str) -> Option<usize> {
    const KEYWORD: &str = "FW_PROJECT_API_KEY";
    if !rest.starts_with(KEYWORD) {
        return None;
    }
    let mut idx = KEYWORD.len();
    idx += consume_while(&rest[idx..], char::is_whitespace);
    let marker = rest[idx..].chars().next()?;
    if marker != '=' && marker != ':' {
        return None;
    }
    idx += marker.len_utf8();
    idx += consume_while(&rest[idx..], char::is_whitespace);
    let token = consume_while(&rest[idx..], |c| !c.is_whitespace());
    if token == 0 {
        return None;
    }
    idx += token;
    Some(idx)
}

/// Collapses whitespace runs to a single space and trims both ends —
/// matches node/python's `.replace(/\s+/g, ' ').trim()` /
/// `re.sub(r"\s+", " ", s).strip()`.
fn collapse_and_trim_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending_space = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !out.is_empty() {
                pending_space = true;
            }
        } else {
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            out.push(ch);
        }
    }
    out
}

/// Redacts secret-shaped substrings (`spec/errors.schema.json`
/// `secretPatterns`) and collapses whitespace runs. Defensive: applied to
/// every message that reaches [`FireweaveError`]'s constructors, even
/// though canonical default messages never contain a secret in the first
/// place — this is the safety net for a message built dynamically
/// elsewhere in the SDK.
pub fn redact_secrets(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut i = 0usize;
    while i < text.len() {
        let rest = &text[i..];
        if let Some(len) = match_project_key_prefix(rest) {
            out.push_str("[REDACTED]");
            i += len;
            continue;
        }
        if let Some(len) = match_bearer_token(rest) {
            out.push_str("[REDACTED]");
            i += len;
            continue;
        }
        if let Some(len) = match_fw_project_api_key_assignment(rest) {
            out.push_str("[REDACTED]");
            i += len;
            continue;
        }
        let ch = rest
            .chars()
            .next()
            .expect("i < text.len() implies a char remains");
        out.push(ch);
        i += ch.len_utf8();
    }
    collapse_and_trim_whitespace(&out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_project_key_prefixes() {
        assert_eq!(
            redact_secrets("key phc_SUPERSECRET0000 leaked"),
            "key [REDACTED] leaked"
        );
        assert_eq!(redact_secrets("phs_abc-DEF_123"), "[REDACTED]");
        assert_eq!(redact_secrets("phx_"), "[REDACTED]");
    }

    #[test]
    fn redacts_bearer_tokens() {
        assert_eq!(
            redact_secrets("Authorization: Bearer abc.def.ghi"),
            "Authorization: [REDACTED]"
        );
    }

    #[test]
    fn redacts_fw_project_api_key_assignment() {
        assert_eq!(
            redact_secrets("FW_PROJECT_API_KEY=supersecret"),
            "[REDACTED]"
        );
        assert_eq!(
            redact_secrets("FW_PROJECT_API_KEY : supersecret"),
            "[REDACTED]"
        );
        // No assignment marker -> not matched (mirrors the reference regex).
        assert_eq!(
            redact_secrets("FW_PROJECT_API_KEY is unset"),
            "FW_PROJECT_API_KEY is unset"
        );
    }

    #[test]
    fn collapses_whitespace_and_trims() {
        assert_eq!(redact_secrets("  a   b\n\tc  "), "a b c");
    }

    #[test]
    fn leaves_ordinary_text_alone() {
        assert_eq!(
            redact_secrets("invalid configuration"),
            "invalid configuration"
        );
    }

    #[test]
    fn error_kind_taxonomy_has_fifteen_members() {
        let all = [
            ErrorKind::NotReady,
            ErrorKind::FlagNotFound,
            ErrorKind::TypeMismatch,
            ErrorKind::InvalidContext,
            ErrorKind::Authentication,
            ErrorKind::Authorization,
            ErrorKind::RateLimited,
            ErrorKind::Timeout,
            ErrorKind::Network,
            ErrorKind::BackendUnavailable,
            ErrorKind::MalformedResponse,
            ErrorKind::UnsupportedCapability,
            ErrorKind::Configuration,
            ErrorKind::AlreadyClosed,
            ErrorKind::Internal,
        ];
        assert_eq!(all.len(), 15);
    }

    #[test]
    fn targeting_key_missing_overrides_the_error_code() {
        let err = FireweaveError::targeting_key_missing();
        assert_eq!(err.openfeature_error_code(), "TARGETING_KEY_MISSING");
        assert_eq!(err.kind, ErrorKind::InvalidContext);
    }

    #[test]
    fn configuration_init_fatal_overrides_the_error_code() {
        let err = FireweaveError::configuration("bad host", true);
        assert_eq!(err.openfeature_error_code(), "PROVIDER_FATAL");
        let runtime_err = FireweaveError::configuration("bad host", false);
        assert_eq!(runtime_err.openfeature_error_code(), "GENERAL");
    }

    #[test]
    fn already_closed_maps_to_provider_not_ready() {
        assert_eq!(
            FireweaveError::new(ErrorKind::AlreadyClosed).openfeature_error_code(),
            "PROVIDER_NOT_READY"
        );
    }
}
