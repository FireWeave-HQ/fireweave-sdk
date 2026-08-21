//! `FireweaveRuntime`: shared engine behind `FireweaveClient`. Owns
//! lifecycle state machine, context layering, and the evaluation pipeline.
//! Reads never panic/raise: evaluation always returns a
//! [`crate::domain::decision::Decision`] (`spec/control-points.md` "Return
//! discipline").

use std::sync::Mutex;

use crate::domain::context::{
    merge_contexts, ContextLimits, EvaluationContext, DEFAULT_RESERVED_ATTRIBUTE_KEYS,
};
use crate::domain::decision::{reason, Decision};
use crate::domain::errors::{ErrorKind, FireweaveError, FLAG_METADATA_ERROR_KIND_KEY};
use crate::domain::types::{FlagMetadata, FlagType, JsonValue};
use crate::domain::validation::{
    matches_expected_type, validate_context, validate_control_point_key, validate_default_value,
};

use super::ports::{
    BackendAdapter, EvaluateOptions, FlagResolution, RegisterTargetOptions, RegisterTargetResult,
};

/// Default bound on shutdown (matches node's `DEFAULT_SHUTDOWN_TIMEOUT_MS`).
pub const DEFAULT_SHUTDOWN_TIMEOUT_MS: u64 = 10_000;

/// JSON-serialize with the deterministic key order
/// `spec/decision.schema.json`'s `fireweave.payload` stable-JSON-string
/// requirement needs. `serde_json::Map`'s default (no `preserve_order`
/// feature — this crate never enables it) backing store is a `BTreeMap`, so
/// every object anywhere in the tree already serializes with sorted keys;
/// unlike node/python, this SDK needs no dedicated stable-stringify helper
/// beyond plain `serde_json::to_string`.
fn stable_json(value: &JsonValue) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// Provider lifecycle state (`spec/modes.md`). `wire_name()` is the
/// provider-state name `contracts/` fixtures compare against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleState {
    Uninitialized,
    Initializing,
    Ready,
    Stale,
    Error,
    Fatal,
    Shutdown,
}

impl LifecycleState {
    pub fn wire_name(&self) -> &'static str {
        match self {
            LifecycleState::Uninitialized | LifecycleState::Initializing => "NOT_READY",
            LifecycleState::Ready => "READY",
            LifecycleState::Stale => "STALE",
            LifecycleState::Error => "ERROR",
            LifecycleState::Fatal => "FATAL",
            LifecycleState::Shutdown => "CLOSED",
        }
    }
}

/// Construction-time configuration for [`FireweaveRuntime`].
pub struct RuntimeConfig {
    pub limits: ContextLimits,
    /// Extra reserved attribute keys, ON TOP OF the canonical
    /// [`DEFAULT_RESERVED_ATTRIBUTE_KEYS`] pair (`targetingKey`, `kind`).
    pub reserved_attribute_keys: Vec<String>,
    pub require_targeting_key: bool,
    pub shutdown_timeout_ms: u64,
    pub global_context: Option<EvaluationContext>,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        RuntimeConfig {
            limits: ContextLimits::default(),
            reserved_attribute_keys: Vec::new(),
            require_targeting_key: false,
            shutdown_timeout_ms: DEFAULT_SHUTDOWN_TIMEOUT_MS,
            global_context: None,
        }
    }
}

/// State guarded by [`FireweaveRuntime`]'s single lock — mirrors python's
/// one `threading.RLock` covering the lifecycle state machine AND the
/// context layers (never the adapter call itself: `evaluate` releases the
/// lock before calling `adapter.resolve`, so concurrent reads are not
/// serialized through this runtime — only through whatever internal
/// synchronization the adapter itself uses).
struct RuntimeInner {
    state: LifecycleState,
    init_error: Option<FireweaveError>,
    global_context: Option<EvaluationContext>,
    client_context: Option<EvaluationContext>,
}

/// Owns lifecycle, context layering, and the evaluation pipeline.
/// `Send + Sync` (every field is), so a caller shares one instance across
/// threads via `Arc<FireweaveRuntime>` — the natural shape for a blocking
/// server SDK evaluating concurrently from many request-handler threads.
pub struct FireweaveRuntime {
    adapter: Box<dyn BackendAdapter>,
    limits: ContextLimits,
    reserved_attribute_keys: Vec<String>,
    require_targeting_key: bool,
    shutdown_timeout_ms: u64,
    inner: Mutex<RuntimeInner>,
}

impl FireweaveRuntime {
    pub fn new(adapter: Box<dyn BackendAdapter>, config: RuntimeConfig) -> Self {
        FireweaveRuntime {
            adapter,
            limits: config.limits,
            reserved_attribute_keys: config.reserved_attribute_keys,
            require_targeting_key: config.require_targeting_key,
            shutdown_timeout_ms: config.shutdown_timeout_ms,
            inner: Mutex::new(RuntimeInner {
                state: LifecycleState::Uninitialized,
                init_error: None,
                global_context: config.global_context,
                client_context: None,
            }),
        }
    }

    // -- lifecycle -----------------------------------------------------------

    pub fn state(&self) -> LifecycleState {
        self.inner.lock().expect("runtime lock poisoned").state
    }

    pub fn adapter(&self) -> &dyn BackendAdapter {
        self.adapter.as_ref()
    }

    /// Transition `Uninitialized` -> `Ready`; `Fatal` on configuration
    /// failure. Returns the underlying error so
    /// `application::mode::init_fireweave` can propagate it —
    /// initialisation fails loudly (`spec/modes.md`); the runtime state is
    /// updated first so later evaluations degrade safely.
    pub fn initialize(&self) -> Result<(), FireweaveError> {
        {
            let mut inner = self.inner.lock().expect("runtime lock poisoned");
            match inner.state {
                LifecycleState::Shutdown => {
                    return Err(FireweaveError::new(ErrorKind::AlreadyClosed))
                }
                LifecycleState::Ready => return Ok(()),
                _ => {}
            }
            inner.state = LifecycleState::Initializing;
        }
        match self.adapter.initialize() {
            Ok(()) => {
                let mut inner = self.inner.lock().expect("runtime lock poisoned");
                inner.state = LifecycleState::Ready;
                inner.init_error = None;
                Ok(())
            }
            Err(err) => {
                let mut inner = self.inner.lock().expect("runtime lock poisoned");
                inner.state = LifecycleState::Fatal;
                inner.init_error = Some(err.clone());
                Err(err)
            }
        }
    }

    /// Extension-call lifecycle gate (kept for `invoke_capability`, even
    /// though `SUPPORTED_CAPABILITIES` is empty in v1 and never reaches it
    /// today): READY/STALE pass (`None`); after shutdown the gate is
    /// `AlreadyClosed`; any pre-ready state degrades with
    /// `UnsupportedCapability`. Callers convert the returned error into a
    /// structured result — extension APIs never panic for lifecycle
    /// reasons.
    pub fn lifecycle_gate(&self) -> Option<FireweaveError> {
        match self.state() {
            LifecycleState::Ready | LifecycleState::Stale => None,
            LifecycleState::Shutdown => Some(FireweaveError::new(ErrorKind::AlreadyClosed)),
            _ => Some(FireweaveError::new(ErrorKind::UnsupportedCapability)),
        }
    }

    /// Test/fixture hook: mark a READY runtime STALE (only takes effect
    /// from READY).
    pub fn mark_stale(&self) {
        let mut inner = self.inner.lock().expect("runtime lock poisoned");
        if inner.state == LifecycleState::Ready {
            inner.state = LifecycleState::Stale;
        }
    }

    /// Test hook: pin the lifecycle state directly.
    pub fn force_state(&self, state: LifecycleState) {
        self.inner.lock().expect("runtime lock poisoned").state = state;
    }

    /// Deterministic, idempotent shutdown; never panics.
    pub fn shutdown(&self) {
        {
            let mut inner = self.inner.lock().expect("runtime lock poisoned");
            if inner.state == LifecycleState::Shutdown {
                return;
            }
            inner.state = LifecycleState::Shutdown;
        }
        self.adapter.shutdown(self.shutdown_timeout_ms);
    }

    // -- context layering -----------------------------------------------------

    pub fn set_global_context(&self, context: Option<EvaluationContext>) {
        self.inner
            .lock()
            .expect("runtime lock poisoned")
            .global_context = context;
    }

    pub fn set_client_context(&self, context: Option<EvaluationContext>) {
        self.inner
            .lock()
            .expect("runtime lock poisoned")
            .client_context = context;
    }

    pub fn merged_context(&self, invocation: Option<&EvaluationContext>) -> EvaluationContext {
        let inner = self.inner.lock().expect("runtime lock poisoned");
        merge_contexts(&[
            inner.global_context.as_ref(),
            inner.client_context.as_ref(),
            invocation,
        ])
    }

    // -- target registration ---------------------------------------------------

    /// Register a user or device so rules can target its durable
    /// properties. Resolves `ok: false` instead of panicking: this runs in
    /// sign-in paths, where a targeting concern must not break
    /// authentication (`spec/modes.md` "registerTarget in local mode").
    pub fn register_target(
        &self,
        targeting_key: &str,
        options: Option<&RegisterTargetOptions>,
    ) -> RegisterTargetResult {
        if let Some(err) = self.lifecycle_error() {
            return RegisterTargetResult::failure(err);
        }
        self.adapter.register_target(targeting_key, options)
    }

    /// Evaluation/registration lifecycle gate (`NotReady` / `AlreadyClosed`).
    fn lifecycle_error(&self) -> Option<FireweaveError> {
        let inner = self.inner.lock().expect("runtime lock poisoned");
        match inner.state {
            LifecycleState::Ready | LifecycleState::Stale => None,
            LifecycleState::Shutdown => Some(FireweaveError::new(ErrorKind::AlreadyClosed)),
            LifecycleState::Fatal => Some(
                inner
                    .init_error
                    .clone()
                    .unwrap_or_else(|| FireweaveError::new(ErrorKind::Configuration)),
            ),
            _ => Some(FireweaveError::new(ErrorKind::NotReady)),
        }
    }

    // -- evaluation pipeline -----------------------------------------------------

    /// Evaluate a flag. Never panics; failures return the default.
    ///
    /// Validates in the fixed order `spec/control-points.md` "Validation,
    /// before any I/O" names, stopping at the first failure: (1) key, (2)
    /// default vs type, (3) context, (4) lifecycle. Only once all four pass
    /// does this reach the adapter (the one I/O call in this method).
    pub fn evaluate(
        &self,
        flag_key: &str,
        flag_type: FlagType,
        default_value: JsonValue,
        invocation_context: Option<&EvaluationContext>,
        options: Option<&EvaluateOptions>,
    ) -> Decision {
        if let Err(err) = validate_control_point_key(flag_key) {
            return Self::error_decision(default_value, err);
        }
        if let Err(err) = validate_default_value(flag_type, &default_value) {
            return Self::error_decision(default_value, err);
        }

        let merged = self.merged_context(invocation_context);
        let reserved: Vec<&str> = DEFAULT_RESERVED_ATTRIBUTE_KEYS
            .iter()
            .copied()
            .chain(self.reserved_attribute_keys.iter().map(String::as_str))
            .collect();
        if let Err(err) =
            validate_context(&merged, &self.limits, &reserved, self.require_targeting_key)
        {
            return Self::error_decision(default_value, err);
        }

        if let Some(err) = self.lifecycle_error() {
            return Self::error_decision(default_value, err);
        }

        match self.adapter.resolve(flag_key, &merged) {
            Ok(resolution) => {
                self.decision_from_resolution(resolution, flag_type, default_value, options)
            }
            Err(err) => Self::error_decision(default_value, err),
        }
    }

    // -- helpers ---------------------------------------------------------------

    fn decision_from_resolution(
        &self,
        resolution: FlagResolution,
        flag_type: FlagType,
        default_value: JsonValue,
        options: Option<&EvaluateOptions>,
    ) -> Decision {
        if !resolution.matched {
            // spec/modes.md "Behaviour per mode": local's unknown-key row is
            // default/reason DEFAULT — deliberately not an error. Any
            // adapter that reports matched: false gets this branch (the
            // strict seam); an adapter signalling a genuine backend-side
            // "unknown key" instead RETURNS Err(FlagNotFound), which is
            // caught in `evaluate` and takes the ERROR branch below.
            return Decision::new(default_value, None, reason::DEFAULT);
        }

        if !matches_expected_type(&resolution.value, flag_type) {
            return Self::error_decision(
                default_value,
                FireweaveError::new(ErrorKind::TypeMismatch),
            );
        }

        let reason_str = if let Some(r) = &resolution.fireweave_reason {
            r.clone()
        } else if !resolution.enabled {
            reason::DISABLED.to_string()
        } else if resolution.from_cache || self.state() == LifecycleState::Stale {
            reason::STALE.to_string()
        } else {
            reason::TARGETING_MATCH.to_string()
        };

        let mut metadata: FlagMetadata = FlagMetadata::new();
        if let Some(version) = resolution.version {
            metadata.insert(
                "fireweave.flagVersion".to_string(),
                JsonValue::from(version),
            );
        }
        // Detailed enrichment (ruling 11): emit fireweave.vendorFlagId +
        // fireweave.reasonCode together, or neither. The runtime's job is
        // only this pass-through pairing — it does NOT re-derive the
        // ruling-11 gate itself (that gate needs a "did the backend report
        // a condition index" signal that only InMemoryAdapter's fixture
        // input carries; FireweaveRemoteAdapter has no such field on the
        // wire and relies on fw-server having already gated flagMetadata
        // before responding). See FlagResolution's doc comment for the
        // full reasoning (task-12 review finding: a stale client-side
        // re-gate on a field the remote wire protocol doesn't carry used
        // to suppress both keys unconditionally for every remote decision).
        if let (Some(vendor_flag_id), Some(reason_code)) =
            (resolution.vendor_flag_id, resolution.reason_code.clone())
        {
            metadata.insert(
                "fireweave.vendorFlagId".to_string(),
                JsonValue::from(vendor_flag_id),
            );
            metadata.insert(
                "fireweave.reasonCode".to_string(),
                JsonValue::String(reason_code),
            );
        }
        if resolution.from_cache {
            metadata.insert("fireweave.fromCache".to_string(), JsonValue::Bool(true));
        }
        if let Some(opts) = options {
            if opts.include_payload {
                if let Some(payload) = &resolution.payload {
                    let payload_str = match payload {
                        JsonValue::String(s) => s.clone(),
                        other => stable_json(other),
                    };
                    metadata.insert(
                        "fireweave.payload".to_string(),
                        JsonValue::String(payload_str),
                    );
                }
            }
        }
        for (k, v) in resolution.extra_metadata.iter() {
            metadata.insert(k.clone(), v.clone());
        }

        Decision {
            value: resolution.value,
            variant: resolution.variant,
            reason: reason_str,
            error_code: None,
            error_message: None,
            error_kind: None,
            flag_metadata: metadata,
        }
    }

    fn error_decision(default_value: JsonValue, error: FireweaveError) -> Decision {
        let mut metadata: FlagMetadata = FlagMetadata::new();
        metadata.insert(
            FLAG_METADATA_ERROR_KIND_KEY.to_string(),
            JsonValue::String(error.kind.as_str().to_string()),
        );
        if error.kind == ErrorKind::FlagNotFound && error.quota_limited {
            metadata.insert("fireweave.quotaLimited".to_string(), JsonValue::Bool(true));
        }
        Decision {
            value: default_value,
            variant: None,
            reason: reason::ERROR.to_string(),
            error_code: Some(error.openfeature_error_code().to_string()),
            error_message: Some(error.message.clone()),
            error_kind: Some(error.kind),
            flag_metadata: metadata,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::adapters::memory::InMemoryAdapter;
    use serde_json::json;

    fn flag_def(value: JsonValue) -> serde_json::Map<String, JsonValue> {
        let mut def = serde_json::Map::new();
        def.insert("type".to_string(), JsonValue::from("boolean"));
        def.insert("enabled".to_string(), JsonValue::Bool(true));
        def.insert("variant".to_string(), JsonValue::from("on"));
        def.insert("value".to_string(), value);
        def
    }

    #[test]
    fn evaluate_before_initialize_is_not_ready() {
        let adapter = InMemoryAdapter::new(Default::default());
        let runtime = FireweaveRuntime::new(Box::new(adapter), RuntimeConfig::default());
        let decision =
            runtime.evaluate("any", FlagType::Boolean, JsonValue::Bool(false), None, None);
        assert_eq!(decision.reason, reason::ERROR);
        assert_eq!(decision.error_kind, Some(ErrorKind::NotReady));
        assert_eq!(decision.value, JsonValue::Bool(false));
    }

    #[test]
    fn evaluate_after_shutdown_is_already_closed() {
        let adapter = InMemoryAdapter::new(Default::default());
        let runtime = FireweaveRuntime::new(Box::new(adapter), RuntimeConfig::default());
        runtime.initialize().unwrap();
        runtime.shutdown();
        let decision =
            runtime.evaluate("any", FlagType::Boolean, JsonValue::Bool(false), None, None);
        assert_eq!(decision.error_kind, Some(ErrorKind::AlreadyClosed));
    }

    #[test]
    fn shutdown_is_idempotent() {
        let adapter = InMemoryAdapter::new(Default::default());
        let runtime = FireweaveRuntime::new(Box::new(adapter), RuntimeConfig::default());
        runtime.initialize().unwrap();
        runtime.shutdown();
        runtime.shutdown();
        assert_eq!(runtime.state(), LifecycleState::Shutdown);
    }

    #[test]
    fn matched_flag_resolves_with_targeting_match() {
        let mut flags = serde_json::Map::new();
        flags.insert(
            "my-flag".to_string(),
            JsonValue::Object(flag_def(JsonValue::Bool(true))),
        );
        let adapter = InMemoryAdapter::new(flags);
        let runtime = FireweaveRuntime::new(Box::new(adapter), RuntimeConfig::default());
        runtime.initialize().unwrap();
        let ctx = EvaluationContext::new().with_targeting_key("t1");
        let decision = runtime.evaluate(
            "my-flag",
            FlagType::Boolean,
            JsonValue::Bool(false),
            Some(&ctx),
            None,
        );
        assert_eq!(decision.value, JsonValue::Bool(true));
        assert_eq!(decision.reason, reason::TARGETING_MATCH);
    }

    #[test]
    fn missing_flag_is_flag_not_found() {
        let adapter = InMemoryAdapter::new(Default::default());
        let runtime = FireweaveRuntime::new(Box::new(adapter), RuntimeConfig::default());
        runtime.initialize().unwrap();
        let ctx = EvaluationContext::new().with_targeting_key("t1");
        let decision = runtime.evaluate(
            "missing",
            FlagType::Boolean,
            JsonValue::Bool(false),
            Some(&ctx),
            None,
        );
        assert_eq!(decision.error_kind, Some(ErrorKind::FlagNotFound));
        assert_eq!(decision.value, JsonValue::Bool(false));
    }

    #[test]
    fn payload_attached_only_when_include_payload_is_set() {
        let mut def = flag_def(JsonValue::Bool(true));
        def.insert(
            "payload".to_string(),
            json!({"rolloutId": "r1", "maxRetries": 2}),
        );
        let mut flags = serde_json::Map::new();
        flags.insert("p".to_string(), JsonValue::Object(def));
        let adapter = InMemoryAdapter::new(flags);
        let runtime = FireweaveRuntime::new(Box::new(adapter), RuntimeConfig::default());
        runtime.initialize().unwrap();
        let ctx = EvaluationContext::new().with_targeting_key("t1");

        let without = runtime.evaluate(
            "p",
            FlagType::Boolean,
            JsonValue::Bool(false),
            Some(&ctx),
            None,
        );
        assert!(!without.flag_metadata.contains_key("fireweave.payload"));

        let opts = EvaluateOptions {
            include_payload: true,
        };
        let with = runtime.evaluate(
            "p",
            FlagType::Boolean,
            JsonValue::Bool(false),
            Some(&ctx),
            Some(&opts),
        );
        assert_eq!(
            with.flag_metadata
                .get("fireweave.payload")
                .and_then(JsonValue::as_str),
            Some("{\"maxRetries\":2,\"rolloutId\":\"r1\"}")
        );
    }
}
