//! The flags declaration: every control point the app reads, with the value
//! served in local mode. It lives in its own file (`src/fireweave_flags.rs`
//! by convention) and is passed as `StartOptions { flags, .. }`.
//!
//! It holds local values only. In remote mode fw-server and the rollout
//! decide, and call sites keep `false` as their default, so a flags file can
//! never switch a feature on in production.

use std::collections::{BTreeMap, HashMap};

use crate::{validate_control_point_key, FireweaveError};

/// One control point the app reads.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Flag {
    /// The value served in local mode. Ignored in remote mode.
    pub local: bool,
    /// Optional note for humans and agents. Never sent anywhere.
    pub description: Option<String>,
}

impl Flag {
    /// A flag served as `value` in local mode.
    pub fn local(value: bool) -> Self {
        Flag {
            local: value,
            description: None,
        }
    }

    /// Adds a note for humans and agents. Never sent anywhere.
    pub fn describe(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }
}

/// Every control point the app reads, keyed by control point key. Built by
/// [`define_flags`] (or [`try_define_flags`]), so every key has passed the
/// core's control point key rule.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Flags {
    entries: BTreeMap<String, Flag>,
}

impl Flags {
    /// No flags: every local-mode read gets its default.
    pub fn new() -> Self {
        Flags::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, key: &str) -> Option<&Flag> {
        self.entries.get(key)
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.entries.contains_key(key)
    }

    /// Entries in key order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &Flag)> {
        self.entries.iter().map(|(k, v)| (k.as_str(), v))
    }

    /// The core local adapter's seed map.
    pub(crate) fn local_seeds(&self) -> HashMap<String, bool> {
        self.entries
            .iter()
            .map(|(k, v)| (k.clone(), v.local))
            .collect()
    }

    /// The local values only, for the idempotency check.
    pub(crate) fn local_values(&self) -> BTreeMap<String, bool> {
        self.entries
            .iter()
            .map(|(k, v)| (k.clone(), v.local))
            .collect()
    }
}

fn config_error(message: String) -> FireweaveError {
    FireweaveError::configuration(message, true)
}

/// Declares the app's control points, checking every key with the core's
/// control point key rule (non-empty, at most 256 characters, no control
/// characters) and rejecting a key declared twice.
///
/// Returns a `Configuration` [`FireweaveError`] naming the offending key.
pub fn try_define_flags<I, K>(entries: I) -> Result<Flags, FireweaveError>
where
    I: IntoIterator<Item = (K, Flag)>,
    K: Into<String>,
{
    let mut out = BTreeMap::new();
    for (key, flag) in entries {
        let key: String = key.into();
        if let Err(err) = validate_control_point_key(&key) {
            return Err(config_error(format!(
                "flags: {key:?} is not a valid control point key ({}).",
                err.message
            )));
        }
        if out.contains_key(&key) {
            return Err(config_error(format!("flags: {key:?} is declared twice.")));
        }
        out.insert(key, flag);
    }
    Ok(Flags { entries: out })
}

/// Declares the app's control points. Like [`try_define_flags`], but panics
/// on a bad entry, so a typo fails where it was made (the flags file is code,
/// like a regex literal).
///
/// ```
/// use fireweave::start::{define_flags, Flag, Flags};
///
/// // src/fireweave_flags.rs
/// pub fn flags() -> Flags {
///     define_flags([
///         ("new-checkout", Flag::local(true).describe("new checkout flow")),
///         ("dark-mode", Flag::local(false)),
///     ])
/// }
/// assert_eq!(flags().len(), 2);
/// ```
///
/// # Panics
///
/// With the `Configuration` error of [`try_define_flags`] when a key is
/// invalid or declared twice.
pub fn define_flags<I, K>(entries: I) -> Flags
where
    I: IntoIterator<Item = (K, Flag)>,
    K: Into<String>,
{
    match try_define_flags(entries) {
        Ok(flags) => flags,
        Err(err) => panic!("fireweave: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ErrorKind;

    #[test]
    fn define_flags_returns_every_entry_in_key_order() {
        let flags = define_flags([("b", Flag::local(false)), ("a", Flag::local(true))]);
        let keys: Vec<&str> = flags.iter().map(|(k, _)| k).collect();
        assert_eq!(keys, vec!["a", "b"]);
        assert!(flags.get("a").unwrap().local);
        assert_eq!(flags.local_seeds().get("b"), Some(&false));
    }

    #[test]
    fn a_bad_key_is_a_configuration_error_naming_it() {
        let err = try_define_flags([("", Flag::local(true))]).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Configuration);
        assert!(err
            .message
            .contains("\"\" is not a valid control point key"));

        let long = "k".repeat(257);
        assert!(try_define_flags([(long, Flag::local(true))]).is_err());
        let err = try_define_flags([("bad\u{7}key", Flag::local(true))]).unwrap_err();
        assert!(err.message.contains("bad\\u{7}key"), "{}", err.message);
    }

    #[test]
    fn a_duplicate_key_is_rejected() {
        let err =
            try_define_flags([("a", Flag::local(true)), ("a", Flag::local(false))]).unwrap_err();
        assert!(err.message.contains("\"a\" is declared twice"));
    }

    #[test]
    #[should_panic(expected = "is not a valid control point key")]
    fn define_flags_panics_on_a_bad_key() {
        let _ = define_flags([("", Flag::local(true))]);
    }
}
