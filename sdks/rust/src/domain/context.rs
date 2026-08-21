//! Evaluation-context value type: merge order (global -> client ->
//! invocation) over the canonical, structurally-owned attribute map.
//!
//! Bounds are enforced in [`crate::domain::validation::validate_context`]
//! (`spec/control-points.md` "Validation, before any I/O" rule 3).
//!
//! **Spec-ambiguity note (recorded in task-12-report.md as a numbered
//! finding, per the Phase 6 brief):** node/python/web detect a cyclic
//! `attributes` mapping and fail closed with `InvalidContext('context
//! contains a circular reference')`, because their host languages let a
//! plain object/dict hold a reference to one of its own ancestors. `Value`
//! (`attributes: serde_json::Map<String, JsonValue>`) is an owned,
//! acyclic tree by construction — there is no `Rc`/`RefCell` anywhere in
//! its definition, so a caller cannot build a `JsonValue` that contains
//! itself even if they tried. The "cyclic context" row of the
//! `InvalidContext` taxonomy is therefore structurally unreachable for
//! this SDK's context input type, not merely untested; this module
//! deliberately carries no cycle-detection code (and `validate_context`
//! carries no matching check) rather than inventing shared-pointer
//! machinery solely to simulate a hazard the type system already rules
//! out.

use super::types::JsonValue;

/// Sanctioned `fireweave.*` carriers (`spec/evaluation-context.schema.json`):
/// the ONLY `fireweave.*` context keys callers may set. Canonical spelling
/// for group memberships / group properties; plain `groups`/`groupProperties`
/// remain accepted as a documented alias.
pub const ALLOWED_FIREWEAVE_CONTEXT_KEYS: [&str; 2] =
    ["fireweave.groups", "fireweave.groupProperties"];

/// Attribute keys reserved at the evaluation-context boundary
/// (`spec/evaluation-context.schema.json` `reservedKeys`, restricted here to
/// the attribute-level pair validated by `validate_context`;
/// `targetingKey` itself is a top-level field, never an attribute key).
pub const DEFAULT_RESERVED_ATTRIBUTE_KEYS: [&str; 2] = ["targetingKey", "kind"];

/// Context bounds (`spec/evaluation-context.schema.json`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContextLimits {
    pub max_attribute_count: usize,
    pub max_key_bytes: usize,
    pub max_value_bytes: usize,
    pub max_nesting_depth: usize,
    pub max_serialized_bytes: usize,
}

/// Ratified default bounds (`contracts/README.md` "Ratified context limits").
pub const DEFAULT_CONTEXT_LIMITS: ContextLimits = ContextLimits {
    max_attribute_count: 128,
    max_key_bytes: 256,
    max_value_bytes: 4096,
    max_nesting_depth: 6,
    max_serialized_bytes: 65536,
};

impl Default for ContextLimits {
    fn default() -> Self {
        DEFAULT_CONTEXT_LIMITS
    }
}

/// One Fireweave evaluation-context layer (global / client / invocation).
///
/// `attributes` is a plain, owned `serde_json::Map` — no cycle-safety
/// machinery is needed (see the module doc comment).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EvaluationContext {
    pub targeting_key: Option<String>,
    pub attributes: serde_json::Map<String, JsonValue>,
}

impl EvaluationContext {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_targeting_key(mut self, key: impl Into<String>) -> Self {
        self.targeting_key = Some(key.into());
        self
    }

    pub fn with_attribute(mut self, key: impl Into<String>, value: JsonValue) -> Self {
        self.attributes.insert(key.into(), value);
        self
    }

    pub fn with_attributes(mut self, attributes: serde_json::Map<String, JsonValue>) -> Self {
        self.attributes = attributes;
        self
    }

    /// `$`-prefixed attributes: vendor pass-through options.
    pub fn vendor_hints(&self) -> serde_json::Map<String, JsonValue> {
        self.attributes
            .iter()
            .filter(|(k, _)| k.starts_with('$'))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    /// Attributes minus vendor hints (`$`-prefixed keys).
    pub fn plain_attributes(&self) -> serde_json::Map<String, JsonValue> {
        self.attributes
            .iter()
            .filter(|(k, _)| !k.starts_with('$'))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    /// Group memberships from `fireweave.groups` or the plain `groups` alias.
    pub fn groups(&self) -> Option<&serde_json::Map<String, JsonValue>> {
        self.attributes
            .get("fireweave.groups")
            .or_else(|| self.attributes.get("groups"))
            .and_then(JsonValue::as_object)
    }

    /// Group properties from `fireweave.groupProperties` or the plain
    /// `groupProperties` alias.
    pub fn group_properties(&self) -> Option<&serde_json::Map<String, JsonValue>> {
        self.attributes
            .get("fireweave.groupProperties")
            .or_else(|| self.attributes.get("groupProperties"))
            .and_then(JsonValue::as_object)
    }

    /// Plain-JSON snapshot (`{targetingKey?, attributes?}`), matching the
    /// shape conformance fixtures compare against
    /// (`contextSnapshotAfter`/`resolvedContext`).
    pub fn to_json(&self) -> JsonValue {
        let mut out = serde_json::Map::new();
        if let Some(key) = &self.targeting_key {
            out.insert("targetingKey".to_string(), JsonValue::String(key.clone()));
        }
        if !self.attributes.is_empty() {
            out.insert(
                "attributes".to_string(),
                JsonValue::Object(self.attributes.clone()),
            );
        }
        JsonValue::Object(out)
    }
}

/// Merges context layers; later layers win per attribute key.
///
/// Order: global -> client -> invocation (`spec/control-points.md`
/// "Context"). `targeting_key` from the latest layer that sets one wins.
/// Merge is shallow per top-level attribute key.
pub fn merge_contexts(layers: &[Option<&EvaluationContext>]) -> EvaluationContext {
    let mut merged = EvaluationContext::new();
    for layer in layers.iter().flatten() {
        if layer.targeting_key.is_some() {
            merged.targeting_key = layer.targeting_key.clone();
        }
        for (k, v) in layer.attributes.iter() {
            merged.attributes.insert(k.clone(), v.clone());
        }
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_later_layers_win() {
        let global = EvaluationContext::new()
            .with_targeting_key("g")
            .with_attribute("tier", JsonValue::from("bronze"));
        let client = EvaluationContext::new().with_attribute("tier", JsonValue::from("silver"));
        let invocation = EvaluationContext::new().with_attribute("tier", JsonValue::from("gold"));

        let merged = merge_contexts(&[Some(&global), Some(&client), Some(&invocation)]);
        assert_eq!(merged.targeting_key.as_deref(), Some("g"));
        assert_eq!(
            merged.attributes.get("tier"),
            Some(&JsonValue::from("gold"))
        );
    }

    #[test]
    fn merge_skips_absent_layers() {
        let invocation = EvaluationContext::new().with_targeting_key("only-one");
        let merged = merge_contexts(&[None, None, Some(&invocation)]);
        assert_eq!(merged.targeting_key.as_deref(), Some("only-one"));
    }
}
