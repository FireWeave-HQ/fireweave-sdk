//! Deterministic in-memory adapter for tests and conformance fixtures.
//!
//! Resolution is purely definition-driven — no hashing, no percentage
//! bucketing. A flag definition is a JSON object shaped like
//! `contracts/README.md`'s fixture `given.flags.<key>` entries:
//! `enabled`, `variant`, `value`, `payload`, `reason.{code,condition_index}`,
//! `metadata.{version,id}`, `fireweaveReason`, `fromCache`,
//! `matchTargetingKey`, `matchAttribute`, `matchGroups`, `matchPerson`.
//!
//! `matchPerson` is intentionally identical to `matchAttribute` (both
//! deep-equal-check plain context attributes) — this mirrors node/go's
//! `InMemoryAdapter`, which implement the two conditions with the same
//! equality check under two names for descriptive fixture authoring
//! (`contracts/context/ctx-person-and-groups.json`).

use std::sync::{Mutex, RwLock};

use crate::application::ports::{BackendAdapter, FlagResolution};
use crate::domain::context::EvaluationContext;
use crate::domain::errors::{ErrorKind, FireweaveError};
use crate::domain::types::JsonValue;

/// One flag definition, as loaded from a fixture or constructed directly.
#[derive(Debug, Clone, Default)]
pub struct FlagDefinition {
    pub enabled: bool,
    pub variant: Option<String>,
    pub value: JsonValue,
    pub payload: Option<JsonValue>,
    pub reason_code: Option<String>,
    pub condition_index: Option<i64>,
    pub version: Option<i64>,
    pub vendor_flag_id: Option<i64>,
    pub fireweave_reason: Option<String>,
    pub from_cache: bool,
    pub match_targeting_key: Option<String>,
    pub match_attribute: Option<serde_json::Map<String, JsonValue>>,
    pub match_groups: Option<serde_json::Map<String, JsonValue>>,
    pub match_person: Option<serde_json::Map<String, JsonValue>>,
}

/// A fault to raise on every `resolve()` call — protocol-fault fixtures
/// (`contracts/security/*.json`) that declare a fault but run on the
/// in-memory backend, mirroring node's built-in `InMemoryAdapterOptions.fault`.
#[derive(Debug, Clone)]
pub struct InMemoryFault {
    pub kind: ErrorKind,
}

/// Fixture-driven adapter; thread-safe; supports live flag replacement.
pub struct InMemoryAdapter {
    definitions: RwLock<std::collections::HashMap<String, FlagDefinition>>,
    fault: Mutex<Option<InMemoryFault>>,
    closed: Mutex<bool>,
}

fn deep_equal(a: &JsonValue, b: &JsonValue) -> bool {
    a == b
}

fn definition_from_json(value: &JsonValue) -> FlagDefinition {
    let obj = value.as_object().cloned().unwrap_or_default();
    let reason = obj.get("reason").and_then(JsonValue::as_object);
    let metadata = obj.get("metadata").and_then(JsonValue::as_object);
    FlagDefinition {
        enabled: obj
            .get("enabled")
            .and_then(JsonValue::as_bool)
            .unwrap_or(true),
        variant: obj
            .get("variant")
            .and_then(JsonValue::as_str)
            .map(str::to_string),
        value: obj.get("value").cloned().unwrap_or(JsonValue::Null),
        payload: obj.get("payload").cloned().filter(|v| !v.is_null()),
        reason_code: reason
            .and_then(|r| r.get("code"))
            .and_then(JsonValue::as_str)
            .map(str::to_string),
        condition_index: reason
            .and_then(|r| r.get("condition_index"))
            .and_then(JsonValue::as_i64),
        version: metadata
            .and_then(|m| m.get("version"))
            .and_then(JsonValue::as_i64),
        vendor_flag_id: metadata
            .and_then(|m| m.get("id"))
            .and_then(JsonValue::as_i64),
        fireweave_reason: obj
            .get("fireweaveReason")
            .and_then(JsonValue::as_str)
            .map(str::to_string),
        from_cache: obj
            .get("fromCache")
            .and_then(JsonValue::as_bool)
            .unwrap_or(false),
        match_targeting_key: obj
            .get("matchTargetingKey")
            .and_then(JsonValue::as_str)
            .map(str::to_string),
        match_attribute: obj
            .get("matchAttribute")
            .and_then(JsonValue::as_object)
            .cloned(),
        match_groups: obj
            .get("matchGroups")
            .and_then(JsonValue::as_object)
            .cloned(),
        match_person: obj
            .get("matchPerson")
            .and_then(JsonValue::as_object)
            .cloned(),
    }
}

impl InMemoryAdapter {
    /// Builds an adapter from the raw fixture JSON shape
    /// (`given.flags: {key: {...}}`).
    pub fn new(flags: serde_json::Map<String, JsonValue>) -> Self {
        let definitions = flags
            .iter()
            .map(|(k, v)| (k.clone(), definition_from_json(v)))
            .collect();
        InMemoryAdapter {
            definitions: RwLock::new(definitions),
            fault: Mutex::new(None),
            closed: Mutex::new(false),
        }
    }

    /// Builds an adapter directly from typed [`FlagDefinition`]s (for
    /// library callers who are not driving it from fixture JSON).
    pub fn from_definitions(
        definitions: std::collections::HashMap<String, FlagDefinition>,
    ) -> Self {
        InMemoryAdapter {
            definitions: RwLock::new(definitions),
            fault: Mutex::new(None),
            closed: Mutex::new(false),
        }
    }

    pub fn set_flags(&self, flags: serde_json::Map<String, JsonValue>) {
        let definitions = flags
            .iter()
            .map(|(k, v)| (k.clone(), definition_from_json(v)))
            .collect();
        *self.definitions.write().expect("definitions lock poisoned") = definitions;
    }

    /// Every `resolve()` call raises this fault instead of resolving
    /// (protocol-fault fixtures exercised on the in-memory backend).
    pub fn set_fault(&self, fault: Option<InMemoryFault>) {
        *self.fault.lock().expect("fault lock poisoned") = fault;
    }

    pub fn is_closed(&self) -> bool {
        *self.closed.lock().expect("closed lock poisoned")
    }

    fn conditions_match(definition: &FlagDefinition, context: &EvaluationContext) -> bool {
        if let Some(expected_key) = &definition.match_targeting_key {
            if context.targeting_key.as_deref() != Some(expected_key.as_str()) {
                return false;
            }
        }
        if let Some(conditions) = &definition.match_attribute {
            for (key, expected) in conditions.iter() {
                match context.attributes.get(key) {
                    Some(actual) if deep_equal(actual, expected) => {}
                    _ => return false,
                }
            }
        }
        if let Some(conditions) = &definition.match_person {
            for (key, expected) in conditions.iter() {
                match context.attributes.get(key) {
                    Some(actual) if deep_equal(actual, expected) => {}
                    _ => return false,
                }
            }
        }
        if let Some(match_groups) = &definition.match_groups {
            let groups = context.groups();
            for (group_type, expected) in match_groups.iter() {
                let actual = groups.and_then(|g| g.get(group_type));
                if actual != Some(expected) {
                    return false;
                }
            }
        }
        true
    }
}

impl BackendAdapter for InMemoryAdapter {
    fn initialize(&self) -> Result<(), FireweaveError> {
        *self.closed.lock().expect("closed lock poisoned") = false;
        Ok(())
    }

    fn resolve(
        &self,
        flag_key: &str,
        context: &EvaluationContext,
    ) -> Result<FlagResolution, FireweaveError> {
        if let Some(fault) = self.fault.lock().expect("fault lock poisoned").clone() {
            return Err(FireweaveError::new(fault.kind));
        }

        let definitions = self.definitions.read().expect("definitions lock poisoned");
        let definition = match definitions.get(flag_key) {
            // key genuinely unknown to this backend -> ERROR/FlagNotFound
            // (spec/control-points.md return-discipline table), distinct
            // from "conditions did not select this caller" below.
            None => return Err(FireweaveError::new(ErrorKind::FlagNotFound)),
            Some(def) => def,
        };

        let matched = Self::conditions_match(definition, context);
        // Ruling 11 gate (spec/decision.schema.json `standardMetadataKeys`):
        // fireweave.vendorFlagId + fireweave.reasonCode are emitted only
        // when the fixture reports a vendor flag id, a matched-condition
        // index, AND a reason code together — this adapter is the one
        // place that raw "condition index" signal exists (fixture
        // `reason.condition_index`), so it applies the gate itself before
        // handing FlagResolution to the (adapter-agnostic) runtime, rather
        // than exposing `condition_index` on the shared port type. See
        // `application::ports::FlagResolution`'s doc comment for why
        // FireweaveRemoteAdapter does not — and must not — replicate this
        // gate (task-12 review finding).
        let (vendor_flag_id, reason_code) = match (
            definition.vendor_flag_id,
            definition.condition_index,
            definition.reason_code.clone(),
        ) {
            (Some(id), Some(_condition_index), Some(code)) => (Some(id), Some(code)),
            _ => (None, None),
        };
        Ok(FlagResolution {
            value: definition.value.clone(),
            variant: definition.variant.clone(),
            enabled: definition.enabled,
            matched,
            version: definition.version,
            vendor_flag_id,
            reason_code,
            payload: definition.payload.clone(),
            fireweave_reason: definition.fireweave_reason.clone(),
            from_cache: definition.from_cache,
            extra_metadata: Default::default(),
        })
    }

    fn shutdown(&self, _timeout_ms: u64) {
        *self.closed.lock().expect("closed lock poisoned") = true;
    }

    // register_target: no override — the in-memory adapter degrades with
    // UnsupportedCapability via the trait default, matching go's fixture
    // adapter.
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn flags_from(json_value: JsonValue) -> serde_json::Map<String, JsonValue> {
        json_value.as_object().cloned().unwrap()
    }

    #[test]
    fn missing_flag_is_flag_not_found() {
        let adapter = InMemoryAdapter::new(Default::default());
        let err = adapter
            .resolve("nope", &EvaluationContext::new())
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::FlagNotFound);
    }

    #[test]
    fn match_attribute_gates_the_match() {
        let flags = flags_from(json!({
            "f": {"type": "boolean", "enabled": true, "variant": "on", "value": true, "matchAttribute": {"tier": "gold"}}
        }));
        let adapter = InMemoryAdapter::new(flags);
        let matching = EvaluationContext::new().with_attribute("tier", JsonValue::from("gold"));
        assert!(adapter.resolve("f", &matching).unwrap().matched);
        let not_matching =
            EvaluationContext::new().with_attribute("tier", JsonValue::from("bronze"));
        assert!(!adapter.resolve("f", &not_matching).unwrap().matched);
    }

    #[test]
    fn match_person_behaves_like_match_attribute() {
        let flags = flags_from(json!({
            "f": {"type": "boolean", "enabled": true, "variant": "on", "value": true, "matchPerson": {"email_domain": "example.com"}}
        }));
        let adapter = InMemoryAdapter::new(flags);
        let ctx =
            EvaluationContext::new().with_attribute("email_domain", JsonValue::from("example.com"));
        assert!(adapter.resolve("f", &ctx).unwrap().matched);
    }

    #[test]
    fn fault_overrides_every_resolve() {
        let adapter = InMemoryAdapter::new(Default::default());
        adapter.set_fault(Some(InMemoryFault {
            kind: ErrorKind::BackendUnavailable,
        }));
        let err = adapter
            .resolve("anything", &EvaluationContext::new())
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::BackendUnavailable);
    }
}
