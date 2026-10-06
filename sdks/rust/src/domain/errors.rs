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

/// `controlPointMetadata` key carrying the canonical Fireweave kind on error
/// decisions (`spec/errors.schema.json` `rules.controlPointMetadataErrorKindKey`).
pub const CONTROL_POINT_METADATA_ERROR_KIND_KEY: &str = "fireweave.errorKind";

/// Canonical PascalCase error kinds (`spec/errors.schema.json`); exactly 15.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorKind {
    NotReady,
    ControlPointNotFound,
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
            ErrorKind::ControlPointNotFound => "ControlPointNotFound",
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
            ErrorKind::ControlPointNotFound => "flag not found",
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
            ErrorKind::ControlPointNotFound => "FLAG_NOT_FOUND",
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
/// - `quota_limited` — only meaningful on `ControlPointNotFound`: the backend
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

    /// `ControlPointNotFound`, optionally noting the backend reported quota limiting
    /// (`contracts/errors.json`: "quota-limited responses resolve as
    /// ControlPointNotFound with fireweave.quotaLimited metadata").
    pub fn flag_not_found(quota_limited: bool) -> Self {
        let mut err = FireweaveError::new(ErrorKind::ControlPointNotFound);
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
// Secret redaction: `rules.redaction` in `contracts/errors.json` (start-profile
// spec SP-26). A manual scanner, NOT a regex crate: the dependency budget for
// this SDK is exactly ureq + serde + serde_json (tests/architecture_guard.rs).
// Four passes, in the contract's order, each the hand-written equivalent of
// (Java's `Redaction`):
//
//   1. bearer        `(Bearer\s+)[A-Za-z0-9._~+/=-]+`          -> `$1[REDACTED]`
//   2. URL userinfo  `([A-Za-z][A-Za-z0-9+.-]*://)[^/?#@\s]+@` -> `$1[REDACTED]@`
//   3. assignments   `(NAME)(\s*[=:]\s*)(["']?)[^\s"',;]+`    -> `$1$2$3[REDACTED]`
//   4. key values    `(PREFIX)[A-Za-z0-9_-]+`                   -> `[REDACTED]`
//
// A variable NAME alone is never redacted; a prefix followed by anything but
// a token character (`project-api-key_…`) is prose and stays.
// `tests/redaction_contract.rs` runs every contract vector through
// [`redact_secrets`].
// ---------------------------------------------------------------------------

const PLACEHOLDER: &str = "[REDACTED]";

/// Variables whose assigned value is a credential (`rules.redaction.assignmentNames`).
const ASSIGNMENT_NAMES: [&str; 3] = [
    "FIREWEAVE_KEY",
    "FIREWEAVE_BROWSER_KEY",
    "FW_PROJECT_API_KEY",
];

/// Key prefixes whose token is a credential (`rules.redaction.valuePrefixes`).
const VALUE_PREFIXES: [&str; 8] = [
    "project-api-key_",
    "fw_public_",
    "fw_ingest_pub_",
    "fw_org_",
    "cli_at_",
    "phc_",
    "phx_",
    "phs_",
];

/// `\s` as the other SDKs' regex engines read it: ASCII whitespace,
/// vertical tab included.
fn is_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\x0B' | '\x0C' | '\r')
}

fn is_bearer_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '~' | '+' | '/' | '=' | '-')
}

fn is_key_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

fn is_scheme_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')
}

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

/// One left-to-right pass: at each position `matcher` either returns
/// `(consumed, replacement)` or `None`, in which case one char is copied.
fn scan(text: &str, matcher: impl Fn(&str, &str) -> Option<(usize, String)>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut i = 0usize;
    while i < text.len() {
        let rest = &text[i..];
        if let Some((len, replacement)) = matcher(&text[..i], rest) {
            if len > 0 {
                out.push_str(&replacement);
                i += len;
                continue;
            }
        }
        let ch = rest
            .chars()
            .next()
            .expect("i < text.len() implies a char remains");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Pass 1: `Bearer` + whitespace + token; the word and the whitespace stay.
fn match_bearer(_before: &str, rest: &str) -> Option<(usize, String)> {
    const KEYWORD: &str = "Bearer";
    if !rest.starts_with(KEYWORD) {
        return None;
    }
    let ws = consume_while(&rest[KEYWORD.len()..], is_space);
    if ws == 0 {
        return None;
    }
    let head = KEYWORD.len() + ws;
    let token = consume_while(&rest[head..], is_bearer_char);
    if token == 0 {
        return None;
    }
    Some((head + token, format!("{}{PLACEHOLDER}", &rest[..head])))
}

/// Pass 2: `scheme://userinfo@`, matched at the `://`. The scheme (already
/// copied) is the run of scheme characters before it and must contain a
/// letter; the userinfo is `[^/?#@\s]+` up to the `@`.
fn match_url_userinfo(before: &str, rest: &str) -> Option<(usize, String)> {
    const SEP: &str = "://";
    if !rest.starts_with(SEP) {
        return None;
    }
    let scheme_start = before
        .char_indices()
        .rev()
        .take_while(|(_, c)| is_scheme_char(*c))
        .last()
        .map(|(idx, _)| idx)?;
    if !before[scheme_start..]
        .chars()
        .any(|c| c.is_ascii_alphabetic())
    {
        return None;
    }
    let userinfo = consume_while(&rest[SEP.len()..], |c| {
        !is_space(c) && !matches!(c, '/' | '?' | '#' | '@')
    });
    if userinfo == 0 || !rest[SEP.len() + userinfo..].starts_with('@') {
        return None;
    }
    Some((SEP.len() + userinfo + 1, format!("{SEP}{PLACEHOLDER}@")))
}

/// Pass 3: `NAME` + optional spaces + `=` or `:` + optional spaces +
/// optional quote + value; the value (up to whitespace, a quote, a comma or
/// a semicolon) is replaced, everything else stays.
fn match_assignment(_before: &str, rest: &str) -> Option<(usize, String)> {
    let name = ASSIGNMENT_NAMES.iter().find(|n| rest.starts_with(**n))?;
    let mut idx = name.len();
    idx += consume_while(&rest[idx..], is_space);
    let marker = rest[idx..].chars().next()?;
    if marker != '=' && marker != ':' {
        return None;
    }
    idx += marker.len_utf8();
    idx += consume_while(&rest[idx..], is_space);
    if rest[idx..].starts_with(['"', '\'']) {
        idx += 1;
    }
    let value = consume_while(&rest[idx..], |c| {
        !is_space(c) && !matches!(c, '"' | '\'' | ',' | ';')
    });
    if value == 0 {
        return None;
    }
    Some((idx + value, format!("{}{PLACEHOLDER}", &rest[..idx])))
}

/// Pass 4: a known key prefix followed by one or more token characters.
fn match_key_value(_before: &str, rest: &str) -> Option<(usize, String)> {
    let prefix = VALUE_PREFIXES.iter().find(|p| rest.starts_with(**p))?;
    let token = consume_while(&rest[prefix.len()..], is_key_char);
    if token == 0 {
        return None;
    }
    Some((prefix.len() + token, PLACEHOLDER.to_string()))
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

/// Redacts secret-shaped substrings (`contracts/errors.json`
/// `rules.redaction`: bearer tokens, URL userinfo, the values of
/// `FIREWEAVE_KEY`/`FIREWEAVE_BROWSER_KEY`/`FW_PROJECT_API_KEY`, then
/// key-shaped values) and collapses whitespace runs. Defensive: applied to
/// every message that reaches [`FireweaveError`]'s constructors, even
/// though canonical default messages never contain a secret in the first
/// place — this is the safety net for a message built dynamically
/// elsewhere in the SDK.
pub fn redact_secrets(text: &str) -> String {
    let out = scan(text, match_bearer);
    let out = scan(&out, match_url_userinfo);
    let out = scan(&out, match_assignment);
    let out = scan(&out, match_key_value);
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
        // A prefix with no token after it is prose, not a key.
        assert_eq!(redact_secrets("phx_"), "phx_");
    }

    #[test]
    fn redacts_bearer_tokens() {
        assert_eq!(
            redact_secrets("Authorization: Bearer abc.def.ghi"),
            "Authorization: Bearer [REDACTED]"
        );
    }

    #[test]
    fn redacts_fw_project_api_key_assignment() {
        assert_eq!(
            redact_secrets("FW_PROJECT_API_KEY=supersecret"),
            "FW_PROJECT_API_KEY=[REDACTED]"
        );
        assert_eq!(
            redact_secrets("FW_PROJECT_API_KEY : supersecret"),
            "FW_PROJECT_API_KEY : [REDACTED]"
        );
        assert_eq!(
            redact_secrets("FIREWEAVE_KEY='abc',FIREWEAVE_BROWSER_KEY=x;"),
            "FIREWEAVE_KEY='[REDACTED]',FIREWEAVE_BROWSER_KEY=[REDACTED];"
        );
        // No assignment marker -> not matched (mirrors the reference regex).
        assert_eq!(
            redact_secrets("FW_PROJECT_API_KEY is unset"),
            "FW_PROJECT_API_KEY is unset"
        );
    }

    #[test]
    fn redacts_url_userinfo_only_before_an_at() {
        assert_eq!(
            redact_secrets("GET https://u:p@h.example/x and mailto a@b"),
            "GET https://[REDACTED]@h.example/x and mailto a@b"
        );
        assert_eq!(
            redact_secrets("https://h.example/p?q=a@b"),
            "https://h.example/p?q=a@b"
        );
        assert_eq!(redact_secrets("1://u@h"), "1://u@h");
    }

    #[test]
    fn redaction_is_idempotent() {
        let once = redact_secrets("Bearer t.k FIREWEAVE_KEY=\"v\" https://a:b@c phc_x1");
        assert_eq!(
            once,
            "Bearer [REDACTED] FIREWEAVE_KEY=\"[REDACTED]\" https://[REDACTED]@c [REDACTED]"
        );
        assert_eq!(redact_secrets(&once), once);
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
            ErrorKind::ControlPointNotFound,
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
