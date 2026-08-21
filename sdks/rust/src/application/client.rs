//! `FireweaveClient` — control-point evaluation and target registration
//! (`spec/control-points.md`): the only two v1 capabilities. Facade
//! methods degrade instead of panicking.

use std::sync::Arc;

use crate::domain::context::EvaluationContext;
use crate::domain::decision::Decision;
use crate::domain::errors::{ErrorKind, FireweaveError};
use crate::domain::types::{FlagType, JsonValue};

use super::ports::{EvaluateOptions, RegisterTargetOptions, RegisterTargetResult};
use super::runtime::FireweaveRuntime;

/// Result of [`FireweaveClient::invoke_capability`].
#[derive(Debug, Clone)]
pub struct ExtensionResult {
    pub ok: bool,
    pub error_kind: Option<ErrorKind>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub degraded: bool,
}

fn failure(err: FireweaveError, degraded: bool) -> ExtensionResult {
    ExtensionResult {
        ok: false,
        error_kind: Some(err.kind),
        error_code: Some(err.openfeature_error_code().to_string()),
        error_message: Some(err.message),
        degraded,
    }
}

/// Names `invoke_capability` will dispatch instead of degrading with
/// `UnsupportedCapability`. Empty in v1: releases, exposures, signals,
/// capabilities discovery, and guardrails are all out of scope
/// (`spec/control-points.md` "Scope of v1") and MUST NOT be exposed, so a
/// cut namespace's capability string resolves exactly like any other
/// unknown string.
const SUPPORTED_CAPABILITIES: &[&str] = &[];

/// Typed evaluation helpers — the nine methods (`spec/control-points.md`
/// "The nine methods"). Documented as `client.control_points`;
/// `client.flags()` is an identical alias sharing identity (returns a
/// reference to the SAME field), retained for compatibility (ADR-0007,
/// silent — no runtime warning, matching node/go's silent alias).
pub struct ControlPointsNamespace {
    runtime: Arc<FireweaveRuntime>,
}

impl ControlPointsNamespace {
    /// Evaluate a flag to a canonical [`Decision`] — the general form the
    /// eight `get_*` methods delegate to.
    ///
    /// `options` is the reserved fifth argument for cross-language surface
    /// parity (`conformance/surface/control-points.surface.json` pins
    /// `evaluate(key, type, default, context?, options?)` across every
    /// language). This SDK is synchronous (blocking I/O, like python — the
    /// Phase 6 controller ruling), so there is no in-flight-call `signal`
    /// to carry, and v1 reads are side-effect-free by design (no per-call
    /// exposure opt-in to carry either) — both remain N/A.
    pub fn evaluate(
        &self,
        flag_key: &str,
        flag_type: FlagType,
        default: JsonValue,
        context: Option<&EvaluationContext>,
        options: Option<&EvaluateOptions>,
    ) -> Decision {
        self.runtime
            .evaluate(flag_key, flag_type, default, context, options)
    }

    pub fn get_boolean_value(
        &self,
        flag_key: &str,
        default: bool,
        context: Option<&EvaluationContext>,
    ) -> bool {
        let decision = self.evaluate(
            flag_key,
            FlagType::Boolean,
            JsonValue::Bool(default),
            context,
            None,
        );
        decision.value.as_bool().unwrap_or(default)
    }

    pub fn get_string_value(
        &self,
        flag_key: &str,
        default: &str,
        context: Option<&EvaluationContext>,
    ) -> String {
        let decision = self.evaluate(
            flag_key,
            FlagType::String,
            JsonValue::String(default.to_string()),
            context,
            None,
        );
        decision
            .value
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| default.to_string())
    }

    pub fn get_number_value(
        &self,
        flag_key: &str,
        default: f64,
        context: Option<&EvaluationContext>,
    ) -> f64 {
        let decision = self.evaluate(
            flag_key,
            FlagType::Number,
            JsonValue::from(default),
            context,
            None,
        );
        decision.value.as_f64().unwrap_or(default)
    }

    pub fn get_object_value(
        &self,
        flag_key: &str,
        default: JsonValue,
        context: Option<&EvaluationContext>,
    ) -> JsonValue {
        let decision = self.evaluate(flag_key, FlagType::Object, default.clone(), context, None);
        if decision.value.is_object() || decision.value.is_array() {
            decision.value
        } else {
            default
        }
    }

    pub fn get_boolean_details(
        &self,
        flag_key: &str,
        default: bool,
        context: Option<&EvaluationContext>,
    ) -> Decision {
        self.evaluate(
            flag_key,
            FlagType::Boolean,
            JsonValue::Bool(default),
            context,
            None,
        )
    }

    pub fn get_string_details(
        &self,
        flag_key: &str,
        default: &str,
        context: Option<&EvaluationContext>,
    ) -> Decision {
        self.evaluate(
            flag_key,
            FlagType::String,
            JsonValue::String(default.to_string()),
            context,
            None,
        )
    }

    pub fn get_number_details(
        &self,
        flag_key: &str,
        default: f64,
        context: Option<&EvaluationContext>,
    ) -> Decision {
        self.evaluate(
            flag_key,
            FlagType::Number,
            JsonValue::from(default),
            context,
            None,
        )
    }

    pub fn get_object_details(
        &self,
        flag_key: &str,
        default: JsonValue,
        context: Option<&EvaluationContext>,
    ) -> Decision {
        self.evaluate(flag_key, FlagType::Object, default, context, None)
    }
}

/// Top-level Fireweave client: control-point evaluation + target
/// registration — the only two v1 capabilities (`spec/control-points.md`
/// "Scope of v1"). No hidden globals: callers construct the runtime (or go
/// through [`crate::application::mode::init_fireweave`]), so tests inject
/// fakes.
pub struct FireweaveClient {
    runtime: Arc<FireweaveRuntime>,
    pub control_points: ControlPointsNamespace,
}

impl FireweaveClient {
    pub fn new(runtime: Arc<FireweaveRuntime>) -> Self {
        FireweaveClient {
            control_points: ControlPointsNamespace {
                runtime: runtime.clone(),
            },
            runtime,
        }
    }

    /// Control-point evaluation under its former name.
    ///
    /// Identical to [`FireweaveClient::control_points`] and shares its
    /// identity — both are the exact same field, so
    /// `std::ptr::eq(&client.control_points, client.flags())` holds.
    /// Silent at runtime: the alias is permanent, not scheduled for
    /// removal (ADR-0007), so there is nothing to warn a caller toward —
    /// deprecation is conveyed by this doc comment only (no log, and no
    /// env gate to control one, since the SDK reads no environment
    /// variables regardless — `spec/modes.md`).
    pub fn flags(&self) -> &ControlPointsNamespace {
        &self.control_points
    }

    pub fn runtime(&self) -> &Arc<FireweaveRuntime> {
        &self.runtime
    }

    pub fn initialize(&self) -> Result<(), FireweaveError> {
        self.runtime.initialize()
    }

    /// Bind the client-layer evaluation context (merge order: middle).
    pub fn set_context(&self, context: Option<EvaluationContext>) {
        self.runtime.set_client_context(context);
    }

    /// Register durable targeting facts for a target (`spec/modes.md`).
    ///
    /// Resolves `ok: false` rather than panicking: this runs in sign-in
    /// paths, where a targeting concern must not break authentication. In
    /// local mode this records in-process and traces the call; nothing
    /// reaches fw-server (see `infrastructure::adapters::local::FireweaveLocalAdapter::register_target`).
    pub fn register_target(
        &self,
        targeting_key: &str,
        options: Option<&RegisterTargetOptions>,
    ) -> RegisterTargetResult {
        self.runtime.register_target(targeting_key, options)
    }

    /// Dynamic capability dispatch. Unknown capabilities — currently all
    /// of them, v1's `SUPPORTED_CAPABILITIES` is empty — degrade with
    /// `UnsupportedCapability`, never panic.
    pub fn invoke_capability(&self, capability: &str) -> ExtensionResult {
        if !SUPPORTED_CAPABILITIES.contains(&capability) {
            return failure(FireweaveError::new(ErrorKind::UnsupportedCapability), true);
        }
        if let Some(gate_error) = self.runtime.lifecycle_gate() {
            return failure(gate_error, true);
        }
        ExtensionResult {
            ok: true,
            error_kind: None,
            error_code: None,
            error_message: None,
            degraded: false,
        }
    }

    pub fn shutdown(&self) {
        self.runtime.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::runtime::RuntimeConfig;
    use crate::infrastructure::adapters::memory::InMemoryAdapter;

    fn client() -> FireweaveClient {
        let runtime = Arc::new(FireweaveRuntime::new(
            Box::new(InMemoryAdapter::new(Default::default())),
            RuntimeConfig::default(),
        ));
        FireweaveClient::new(runtime)
    }

    #[test]
    fn flags_alias_shares_identity_with_control_points() {
        let fw = client();
        assert!(std::ptr::eq(&fw.control_points, fw.flags()));
    }

    #[test]
    fn invoke_capability_degrades_unsupported() {
        let fw = client();
        fw.initialize().unwrap();
        let result = fw.invoke_capability("releases.teleport");
        assert!(!result.ok);
        assert!(result.degraded);
        assert_eq!(result.error_kind, Some(ErrorKind::UnsupportedCapability));
    }
}
