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
///
/// `vendor_flag_id`/`reason_code` are a PRE-GATED pair
/// (`spec/decision.schema.json` `standardMetadataKeys`, orchestrator ruling
/// 11): the runtime emits `fireweave.vendorFlagId`/`fireweave.reasonCode`
/// together, or neither — never one alone. There is deliberately no
/// separate `condition_index` field here: ruling 11's gate ("both a vendor
/// flag id AND a condition index") is a statement about what the BACKEND
/// reported, and the one place that raw signal exists as adapter input is
/// `InMemoryAdapter` (fixture `reason.condition_index`), which applies the
/// gate itself before setting these two fields — see
/// `infrastructure::adapters::memory`. `FireweaveRemoteAdapter` never had a
/// `conditionIndex` to check in the first place
/// (`spec/remote-evaluate.schema.json`'s `decisionItem` carries no such
/// field): fw-server applies ruling 11 server-side before the wire
/// response is ever built, so the adapter passes `flagMetadata.
/// fireweave.vendorFlagId`/`.fireweave.reasonCode` straight through when
/// present. Carrying a `condition_index` field on this shared, adapter-
/// agnostic port type — and re-gating on it a second time in the runtime —
/// meant the remote path's hardcoded `None` silently defeated the gate for
/// every remote decision (task-12 review finding; regression-tested by
/// `application::runtime::tests::remote_style_metadata_passes_through_when_both_keys_present`).
#[derive(Debug, Clone)]
pub struct FlagResolution {
    pub value: JsonValue,
    pub variant: Option<String>,
    pub enabled: bool,
    pub matched: bool,
    pub version: Option<i64>,
    pub vendor_flag_id: Option<i64>,
    pub reason_code: Option<String>,
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

/// Type-erased self-reference, blanket-implemented for every `'static`
/// type. Lets a caller holding only `&dyn BackendAdapter` (e.g. via
/// [`crate::application::runtime::FireweaveRuntime::adapter`]) downcast
/// back to a concrete adapter type — e.g.
/// `runtime.adapter().as_any().downcast_ref::<FireweaveLocalAdapter>()` to
/// reach `FireweaveLocalAdapter::registered_targets()` (`spec/modes.md`:
/// "The recorded set MUST be readable (`getRegisteredTargets`) so tests
/// can assert registration without capturing stdout").
///
/// This is the direct Rust translation of an already-established
/// cross-language pattern, not a new one: node's own test suite reaches
/// this exact same data via `client.runtime.adapter as
/// FireweaveLocalAdapter` (an unchecked TS cast — safe there only because
/// JS never erases the concrete type at runtime); go's and java's
/// statically-typed equivalents are a checked type assertion
/// (`adapter.(*local.Adapter)`) and an `instanceof`-checked cast,
/// respectively — both, like this, checked downcasts from a generic
/// adapter reference, never a method the generic port interface itself
/// declares. `Any::downcast_ref` is Rust's version of the same checked
/// downcast.
///
/// A SEPARATE trait with a blanket impl, rather than a method declared
/// directly on [`BackendAdapter`], deliberately: `fn as_any(&self) -> &dyn
/// Any { self }` needs `Self: Sized` to coerce `&Self` into `&dyn Any`, and
/// a `where Self: Sized` default on `BackendAdapter` itself would silently
/// drop the method from `dyn BackendAdapter`'s vtable — exactly the call
/// site (`runtime.adapter().as_any()`) this exists for. Blanket-
/// implementing a same-named method on a supertrait instead means every
/// `BackendAdapter` implementor (including adapters outside this crate's
/// own tree, e.g. the conformance runner's test-only wrapper adapters)
/// gets it for free, with no per-adapter boilerplate and no risk of a new
/// adapter forgetting to implement it.
pub trait AsAny {
    fn as_any(&self) -> &dyn std::any::Any;
}

impl<T: 'static> AsAny for T {
    fn as_any(&self) -> &dyn std::any::Any {
        self
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
pub trait BackendAdapter: Send + Sync + AsAny {
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
