//! Fireweave SDK validation — pure, total functions per
//! `spec/control-points.md` "Validation, before any I/O" and
//! `spec/modes.md` "Initialisation validation".
//!
//! Every read-path validator here (`validate_control_point_key`,
//! `validate_default_value`, `validate_context`, `validate_targeting_key`)
//! returns `Result<(), FireweaveError>` rather than raising.
//! [`crate::application::runtime::FireweaveRuntime::evaluate`] runs them,
//! in the fixed order the spec names — key, default-vs-type, context,
//! lifecycle — and degrades to the caller's default on the first failure;
//! it NEVER panics/raises for a malformed/unresolvable read
//! (`spec/control-points.md` "Return discipline — never throw into a read
//! path"). "Ports to Rust `Result`" (Phase 6 controller ruling) describes
//! exactly this: every validator's *internal* representation of
//! success/failure is `Result`, but only [`validate_init_options`] has its
//! failure surfaced as an `Err` by its caller
//! ([`crate::application::mode::init_fireweave`]) — every other
//! validator's `Err` is caught and converted into a default-valued
//! [`crate::domain::decision::Decision`] before it ever reaches a caller.
//!
//! Everything below is pure (no I/O, no ambient state, no environment
//! reads) and total — `conformance/` can exercise all four read-path rules
//! offline, with no backend.

use super::context::{ContextLimits, EvaluationContext};
use super::errors::{ErrorKind, FireweaveError};
use super::mode::Mode;
use super::types::{FlagType, JsonValue};

// ---------------------------------------------------------------------------
// Rule 1 — validate_control_point_key (spec/control-points.md "Validation,
// before any I/O": "key — non-empty, <=256 characters, no control characters")
// ---------------------------------------------------------------------------

const MAX_CONTROL_POINT_KEY_LENGTH: usize = 256;

fn has_control_characters(key: &str) -> bool {
    // C0 + C1 control characters (U+0000-U+001F, U+007F-U+009F).
    key.chars().any(|c| {
        let code = c as u32;
        code <= 0x1F || (0x7F..=0x9F).contains(&code)
    })
}

/// key — non-empty, <=256 characters, no control characters
/// (`spec/control-points.md` rule 1, the first check in the fixed order).
///
/// No taxonomy kind names "malformed key" explicitly (the return-discipline
/// table's closest row is "key unknown to the backend" -> `FlagNotFound`):
/// a key that can never identify a flag is treated the same as one the
/// backend doesn't recognise, so this maps to `FlagNotFound` too.
///
/// Controller-ruled interim mapping (carried over from the node reference):
/// the 15-kind taxonomy in `errors.schema.json` is frozen at exactly 15
/// entries, `InvalidContext` is textually scoped to the evaluation
/// *context* (not the key), and the schema already maps another
/// non-literal case — quota-limited responses — onto `FlagNotFound` rather
/// than adding a kind for it. `FlagNotFound` is therefore the
/// least-wrong existing kind, not a literal fit.
pub fn validate_control_point_key(key: &str) -> Result<(), FireweaveError> {
    if key.is_empty() {
        return Err(FireweaveError::with_message(
            ErrorKind::FlagNotFound,
            "control point key must be a non-empty string",
        ));
    }
    // Character count, not byte count — the spec says "256 characters".
    if key.chars().count() > MAX_CONTROL_POINT_KEY_LENGTH {
        return Err(FireweaveError::with_message(
            ErrorKind::FlagNotFound,
            "control point key exceeds maximum length",
        ));
    }
    if has_control_characters(key) {
        return Err(FireweaveError::with_message(
            ErrorKind::FlagNotFound,
            "control point key contains control characters",
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Rule 2 — validate_default_value (spec/control-points.md rule 2: "default vs
// type — getBooleanValue with a non-boolean default is TypeMismatch")
// ---------------------------------------------------------------------------

/// Whether `value` matches the shape `expected` names. Shared by
/// [`validate_default_value`] (the caller's default, before any I/O) and
/// the runtime's post-resolve check (the backend's resolved value, after
/// I/O) — same predicate, two different inputs.
///
/// `serde_json::Value::Bool` and `Value::Number` are distinct enum
/// variants, so — unlike python, where `bool` is a subclass of `int` and
/// needs an explicit carve-out — there is no "a boolean default
/// accidentally matches NUMBER" hazard to guard against here.
pub fn matches_expected_type(value: &JsonValue, expected: FlagType) -> bool {
    match expected {
        FlagType::Boolean => value.is_boolean(),
        FlagType::String => value.is_string(),
        FlagType::Number => value.is_number(),
        FlagType::Object => value.is_object() || value.is_array(),
    }
}

/// default vs type — e.g. `get_boolean_value` with a non-boolean default is
/// `TypeMismatch` (`spec/control-points.md` rule 2, checked before any I/O).
pub fn validate_default_value(
    expected_type: FlagType,
    default_value: &JsonValue,
) -> Result<(), FireweaveError> {
    if !matches_expected_type(default_value, expected_type) {
        return Err(FireweaveError::new(ErrorKind::TypeMismatch));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// validate_targeting_key (spec/control-points.md "Context": targetingKey)
// ---------------------------------------------------------------------------

/// targetingKey: "An SDK MUST NOT invent one: a missing targeting key is
/// InvalidContext where the evaluation needs it, never a generated
/// anonymous id" (`spec/control-points.md` "Context"). `required` is
/// call-site policy — the remote adapter always requires one; the generic
/// context pipeline ([`validate_context`]) only does when its caller opts
/// in.
pub fn validate_targeting_key(
    targeting_key: Option<&str>,
    required: bool,
) -> Result<(), FireweaveError> {
    if required && targeting_key.map(str::is_empty).unwrap_or(true) {
        return Err(FireweaveError::targeting_key_missing());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Rule 3 — validate_context (spec/control-points.md rule 3: "context — depth,
// key count, value size, reserved keys (evaluation-context.schema.json)")
// ---------------------------------------------------------------------------

fn max_depth_of_value(value: &JsonValue) -> usize {
    match value {
        JsonValue::Object(map) => 1 + map.values().map(max_depth_of_value).max().unwrap_or(0),
        JsonValue::Array(arr) => 1 + arr.iter().map(max_depth_of_value).max().unwrap_or(0),
        _ => 0,
    }
}

/// Depth of the top-level attribute map itself (root = 1, matching
/// `spec/evaluation-context.schema.json` `bounds.maxDepth`'s doc comment).
fn max_depth_of_attrs(attrs: &serde_json::Map<String, JsonValue>) -> usize {
    1 + attrs.values().map(max_depth_of_value).max().unwrap_or(0)
}

fn any_key_exceeds_bytes(value: &JsonValue, limit: usize) -> bool {
    match value {
        JsonValue::Object(map) => map
            .iter()
            .any(|(k, v)| k.len() > limit || any_key_exceeds_bytes(v, limit)),
        JsonValue::Array(arr) => arr.iter().any(|v| any_key_exceeds_bytes(v, limit)),
        _ => false,
    }
}

fn any_string_value_exceeds_bytes(value: &JsonValue, limit: usize) -> bool {
    match value {
        JsonValue::Object(map) => map
            .values()
            .any(|v| any_string_value_exceeds_bytes(v, limit)),
        JsonValue::Array(arr) => arr.iter().any(|v| any_string_value_exceeds_bytes(v, limit)),
        JsonValue::String(s) => s.len() > limit,
        _ => false,
    }
}

/// context — depth, key count, value size, reserved keys
/// (`evaluation-context.schema.json`) (`spec/control-points.md` rule 3).
/// Also enforces `require_targeting_key` via [`validate_targeting_key`].
///
/// Unlike the node/python/web reference SDKs, this function carries no
/// cycle check: `EvaluationContext.attributes` is an owned
/// `serde_json::Map` tree with no shared/back-references possible, so a
/// cyclic context is structurally unreachable for this SDK's context input
/// type — see the module doc comment on `domain::context` for the full
/// spec-ambiguity note (recorded in task-12-report.md).
pub fn validate_context(
    context: &EvaluationContext,
    limits: &ContextLimits,
    reserved_keys: &[&str],
    require_targeting_key: bool,
) -> Result<(), FireweaveError> {
    let attrs = &context.attributes;

    for key in attrs.keys() {
        if reserved_keys.contains(&key.as_str()) {
            return Err(FireweaveError::new(ErrorKind::InvalidContext));
        }
        if key.starts_with("fireweave.")
            && !super::context::ALLOWED_FIREWEAVE_CONTEXT_KEYS.contains(&key.as_str())
        {
            return Err(FireweaveError::new(ErrorKind::InvalidContext));
        }
    }

    if attrs.len() > limits.max_attribute_count {
        return Err(FireweaveError::with_message(
            ErrorKind::InvalidContext,
            "context exceeds maximum attribute count",
        ));
    }

    if attrs.iter().any(|(k, v)| {
        k.len() > limits.max_key_bytes || any_key_exceeds_bytes(v, limits.max_key_bytes)
    }) {
        return Err(FireweaveError::with_message(
            ErrorKind::InvalidContext,
            "context key exceeds maximum size",
        ));
    }

    if attrs
        .values()
        .any(|v| any_string_value_exceeds_bytes(v, limits.max_value_bytes))
    {
        return Err(FireweaveError::with_message(
            ErrorKind::InvalidContext,
            "context value exceeds maximum size",
        ));
    }

    if max_depth_of_attrs(attrs) > limits.max_nesting_depth {
        return Err(FireweaveError::with_message(
            ErrorKind::InvalidContext,
            "context exceeds maximum nesting depth",
        ));
    }

    let mut probe = serde_json::Map::new();
    probe.insert(
        "targetingKey".to_string(),
        context
            .targeting_key
            .clone()
            .map(JsonValue::String)
            .unwrap_or(JsonValue::Null),
    );
    probe.insert("attributes".to_string(), JsonValue::Object(attrs.clone()));
    let serialized_len = serde_json::to_string(&JsonValue::Object(probe))
        .map(|s| s.len())
        .unwrap_or(0);
    if serialized_len > limits.max_serialized_bytes {
        return Err(FireweaveError::with_message(
            ErrorKind::InvalidContext,
            "serialized context exceeds maximum size",
        ));
    }

    validate_targeting_key(context.targeting_key.as_deref(), require_targeting_key)
}

// ---------------------------------------------------------------------------
// validate_init_options (spec/modes.md "Initialisation validation")
// ---------------------------------------------------------------------------

fn is_blank(value: Option<&str>) -> bool {
    value.map(|s| s.trim().is_empty()).unwrap_or(true)
}

/// Initialisation-validation table (`spec/modes.md`), the three rows
/// representable at this layer:
///
/// - `mode` absent (`None`) — "unrecognised" has no Rust analogue; see
///   `domain::mode::Mode`'s doc comment.
/// - `mode == Remote` with `api_key`/`api_url` missing/blank.
/// - `mode == Local` with credentials supplied (a config half-migrated
///   from remote to local reads as neither, silently — reject it instead).
///
/// Row 3 ("apiUrl fails the host allowlist") is intentionally NOT checked
/// here — that check ([`crate::infrastructure::hosts::assert_host_allowed`])
/// lives in `infrastructure/hosts.rs` and is invoked directly by
/// `application::mode::init_fireweave` before any adapter/network I/O
/// happens (a pure `domain/` function must not depend on it).
pub fn validate_init_options(
    mode: Option<Mode>,
    api_key: Option<&str>,
    api_url: Option<&str>,
) -> Result<(), FireweaveError> {
    let mode = match mode {
        Some(m) => m,
        None => {
            return Err(FireweaveError::configuration(
                r#"mode is required and must be "local" or "remote""#,
                true,
            ));
        }
    };
    match mode {
        Mode::Remote => {
            if is_blank(api_key) || is_blank(api_url) {
                return Err(FireweaveError::configuration(
                    r#"mode "remote" requires api_key and api_url"#,
                    true,
                ));
            }
            Ok(())
        }
        Mode::Local => {
            if !is_blank(api_key) || !is_blank(api_url) {
                return Err(FireweaveError::configuration(
                    r#"mode "local" must not be combined with api_key/api_url — the caller means one or the other"#,
                    true,
                ));
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::context::DEFAULT_RESERVED_ATTRIBUTE_KEYS;

    #[test]
    fn key_must_be_non_empty() {
        assert!(validate_control_point_key("").is_err());
        assert!(validate_control_point_key("ok").is_ok());
    }

    #[test]
    fn key_length_is_counted_in_characters() {
        let long_key = "k".repeat(257);
        assert!(validate_control_point_key(&long_key).is_err());
        let ok_key = "k".repeat(256);
        assert!(validate_control_point_key(&ok_key).is_ok());
    }

    #[test]
    fn key_rejects_control_characters() {
        assert!(validate_control_point_key("bad\u{0007}key").is_err());
    }

    #[test]
    fn default_value_type_mismatch() {
        let err =
            validate_default_value(FlagType::Boolean, &JsonValue::from("not-a-bool")).unwrap_err();
        assert_eq!(err.kind, ErrorKind::TypeMismatch);
        assert!(validate_default_value(FlagType::Boolean, &JsonValue::from(true)).is_ok());
    }

    #[test]
    fn targeting_key_required_and_missing() {
        let err = validate_targeting_key(None, true).unwrap_err();
        assert_eq!(err.openfeature_error_code(), "TARGETING_KEY_MISSING");
        assert!(validate_targeting_key(None, false).is_ok());
        assert!(validate_targeting_key(Some("x"), true).is_ok());
    }

    #[test]
    fn context_reserved_keys_rejected() {
        let ctx = EvaluationContext::new()
            .with_targeting_key("t")
            .with_attribute("targetingKey", JsonValue::from("dup"));
        let reserved: Vec<&str> = DEFAULT_RESERVED_ATTRIBUTE_KEYS.to_vec();
        let err = validate_context(&ctx, &ContextLimits::default(), &reserved, false).unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidContext);
    }

    #[test]
    fn context_fireweave_carveout_keys_allowed_others_rejected() {
        let mut groups = serde_json::Map::new();
        groups.insert("organization".to_string(), JsonValue::from("org_1"));
        let ok_ctx = EvaluationContext::new()
            .with_targeting_key("t")
            .with_attribute("fireweave.groups", JsonValue::Object(groups));
        assert!(validate_context(&ok_ctx, &ContextLimits::default(), &[], false).is_ok());

        let bad_ctx = EvaluationContext::new()
            .with_targeting_key("t")
            .with_attribute(
                "fireweave.evaluationContexts",
                JsonValue::from(vec!["production"]),
            );
        assert!(validate_context(&bad_ctx, &ContextLimits::default(), &[], false).is_err());
    }

    #[test]
    fn context_nesting_depth_exceeded() {
        let mut d8 = serde_json::Map::new();
        d8.insert("d9".to_string(), JsonValue::from(true));
        let mut nested = JsonValue::Object(d8);
        for name in ["d8", "d7", "d6", "d5", "d4", "d3", "d2", "d1"] {
            let mut wrap = serde_json::Map::new();
            wrap.insert(name.to_string(), nested);
            nested = JsonValue::Object(wrap);
        }
        let attrs = nested.as_object().unwrap().clone();
        let ctx = EvaluationContext::new()
            .with_targeting_key("t")
            .with_attributes(attrs);
        let err = validate_context(&ctx, &ContextLimits::default(), &[], false).unwrap_err();
        assert_eq!(err.message, "context exceeds maximum nesting depth");
    }

    #[test]
    fn context_attribute_count_exceeded() {
        let mut attrs = serde_json::Map::new();
        for i in 0..200 {
            attrs.insert(format!("a{i}"), JsonValue::from(i));
        }
        let ctx = EvaluationContext::new()
            .with_targeting_key("t")
            .with_attributes(attrs);
        let err = validate_context(&ctx, &ContextLimits::default(), &[], false).unwrap_err();
        assert_eq!(err.message, "context exceeds maximum attribute count");
    }

    #[test]
    fn init_options_mode_absent_is_configuration() {
        let err = validate_init_options(None, None, None).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Configuration);
        assert_eq!(err.openfeature_error_code(), "PROVIDER_FATAL");
    }

    #[test]
    fn init_options_remote_requires_credentials() {
        assert!(validate_init_options(Some(Mode::Remote), None, Some("https://x")).is_err());
        assert!(validate_init_options(Some(Mode::Remote), Some("key"), Some("  ")).is_err());
        assert!(validate_init_options(Some(Mode::Remote), Some("key"), Some("https://x")).is_ok());
    }

    #[test]
    fn init_options_local_rejects_stray_credentials() {
        assert!(validate_init_options(Some(Mode::Local), Some("key"), None).is_err());
        assert!(validate_init_options(Some(Mode::Local), None, None).is_ok());
    }
}
