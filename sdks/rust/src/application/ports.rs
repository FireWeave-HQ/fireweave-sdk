//! `BackendAdapter` trait and the vendor-neutral resolution/target-
//! registration records it exchanges with
//! [`crate::application::runtime::FireweaveRuntime`].
//!
//! Adapters translate a backend (fw-server, an in-process dev map, in-memory
//! fixtures) into [`FlagResolution`] records. No vendor types cross this
//! boundary — the runtime and public API only ever see Fireweave-owned
//! shapes.
//!
//! All `BackendAdapter` methods take `&self` (not `&mut self`): a concrete
//! adapter is responsible for its OWN internal thread-safety (interior
//! mutability via `Mutex`/`RwLock`/atomics), exactly like go's
//! `BackendAdapter` interface and python's per-adapter locks — this lets
//! `FireweaveRuntime` hold `Box<dyn BackendAdapter>` directly and stay
//! `Send + Sync` without wrapping the whole adapter in an extra lock of its
//! own (the runtime's own lock — `application::runtime::RuntimeInner` —
//! guards only the lifecycle state machine and the context layers, mirroring
//! python's single `threading.RLock`).

use crate::domain::context::EvaluationContext;
use crate::domain::errors::{ErrorKind, FireweaveError};
use crate::domain::target::TargetKind;
use crate::domain::types::JsonValue;

/// `evaluate()`'s reserved fifth argument
/// (`conformance/surface/control-points.surface.json`:
/// `evaluate(key, type, default, context?, options?)`).
///
/// `include_payload` (`contracts/evaluation/eval-payload-attached.json`):
/// when true and the resolved flag carries a payload
/// ([`FlagResolution::payload`]), it is attached to
/// `flag_metadata["fireweave.payload"]` as a deterministic (sorted-key)
/// JSON string.
#[derive(Debug, Clone, Copy, Default)]
pub struct EvaluateOptions {
    pub include_payload: bool,
}

/// Options for `POST /v1/targets/register`
/// (`spec/remote-register-target.schema.json`).
///
/// Omitted fields are left off the wire rather than sent as null/default —
/// the server defaults `kind` to `user` when absent.
#[derive(Debug, Clone, Default)]
pub struct RegisterTargetOptions {
    pub kind: Option<TargetKind>,
    pub properties: Option<serde_json::Map<String, JsonValue>>,
    pub environment: Option<String>,
}

/// Outcome of target registration.
///
/// `ok: false` means the target was NOT registered — rules that depend on
/// its properties will not match until a later attempt succeeds. Callers in
/// a login path normally ignore this; a careful caller logs it — a silently
/// unregistered target is exactly how targeting rules end up matching
/// nobody.
#[derive(Debug, Clone)]
pub struct RegisterTargetResult {
    pub ok: bool,
    pub error: Option<FireweaveError>,
}

impl RegisterTargetResult {
    pub fn success() -> Self {
        RegisterTargetResult {
            ok: true,
            error: None,
        }
    }

    pub fn failure(error: FireweaveError) -> Self {
        RegisterTargetResult {
            ok: false,
            error: Some(error),
        }
    }
}

/// Vendor-neutral outcome of resolving one flag.
///
/// `matched: false` is the ONE typed channel an adapter uses to signal "no
/// decision for this key/context" back to the runtime — it is what
/// [`crate::application::runtime::FireweaveRuntime::evaluate`] reads to
/// produce reason `DEFAULT` (`spec/modes.md` "Behaviour per mode": local
/// mode's unknown-key row). Contrast a genuinely-unknown key at a real
/// backend (remote's "key unknown to the backend" row), which resolves to
/// reason `ERROR`/`FlagNotFound` by *returning `Err`* from `resolve`
/// instead of `Ok(FlagResolution { matched: false, .. })` — see
/// `infrastructure::adapters::remote::FireweaveRemoteAdapter::resolve` and
/// `infrastructure::adapters::local::FireweaveLocalAdapter::resolve`.
///
/// `fireweave_reason` lets an adapter force a canonical reason on a
/// *matched* resolution (e.g. the local dev adapter's `STATIC`).
#[derive(Debug, Clone)]
pub struct FlagResolution {
    pub value: JsonValue,
    pub variant: Option<String>,
    pub enabled: bool,
    pub matched: bool,
    pub version: Option<i64>,
    pub vendor_flag_id: Option<i64>,
    pub reason_code: Option<String>,
    pub condition_index: Option<i64>,
    pub payload: Option<JsonValue>,
    pub fireweave_reason: Option<String>,
    pub from_cache: bool,
    pub extra_metadata: serde_json::Map<String, JsonValue>,
}

impl Default for FlagResolution {
    fn default() -> Self {
        FlagResolution {
            value: JsonValue::Null,
            variant: None,
            enabled: true,
            matched: true,
            version: None,
            vendor_flag_id: None,
            reason_code: None,
            condition_index: None,
            payload: None,
            fireweave_reason: None,
            from_cache: false,
            extra_metadata: serde_json::Map::new(),
        }
    }
}

impl FlagResolution {
    /// A miss: no decision for this key/context
    /// (`spec/modes.md` "Behaviour per mode": local's unknown-key row).
    pub fn miss() -> Self {
        FlagResolution {
            matched: false,
            ..Default::default()
        }
    }
}

/// Protocol every Fireweave backend adapter implements.
///
/// `resolve` returns `Err(FireweaveError)` for a genuine backend failure
/// (`FlagNotFound`, `Network`, `Timeout`, ...); the runtime converts those
/// into default-valued decisions — evaluation APIs never propagate them to
/// the caller.
///
/// `register_target` carries a default implementation degrading with
/// `UnsupportedCapability` (mirroring go's `BackendAdapter.RegisterTarget`,
/// which every adapter implements — including the fixture-only in-memory
/// one, which degrades) rather than python's duck-typed optional method.
pub trait BackendAdapter: Send + Sync {
    /// Bring the backend up; return `Err` on fatal config.
    fn initialize(&self) -> Result<(), FireweaveError>;

    /// Resolve one flag against a validated, merged context.
    fn resolve(
        &self,
        flag_key: &str,
        context: &EvaluationContext,
    ) -> Result<FlagResolution, FireweaveError>;

    /// Deterministically release resources within `timeout_ms`.
    /// Idempotent; must never panic.
    fn shutdown(&self, timeout_ms: u64);

    /// Register a target. Adapters without the capability degrade with
    /// `UnsupportedCapability` (this default).
    fn register_target(
        &self,
        targeting_key: &str,
        options: Option<&RegisterTargetOptions>,
    ) -> RegisterTargetResult {
        let _ = (targeting_key, options);
        RegisterTargetResult::failure(FireweaveError::new(ErrorKind::UnsupportedCapability))
    }
}
