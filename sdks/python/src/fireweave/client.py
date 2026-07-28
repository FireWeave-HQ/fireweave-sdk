"""FireweaveClient: evaluation facade + release-safety extensions (§6).

Namespaces: ``flags``, ``releases``, ``exposures``, ``signals``,
``guardrails`` (phase-one UnsupportedCapability stub), ``capabilities``.

Facade rules:

- Extension APIs degrade, they don't throw: failures come back as result
  objects carrying the canonical error kind.
- All outbound telemetry text passes the redaction filter and signal
  attributes pass the allowlist (no secrets / arbitrary PII on the wire).
- Shutdown is deterministic and idempotent: flush exposures, close adapter.
"""

from __future__ import annotations

import importlib.util
import json
import re
import threading
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from ._version import OPENFEATURE_SPEC_FLOOR, SPEC_VERSION, __version__
from .capabilities import CapabilityRegistry
from .context import EvaluationContext
from .decision import Decision
from .errors import (
    ErrorKind,
    FireweaveError,
    UnsupportedCapabilityError,
    redact_secrets,
)
from .runtime import EvaluationOptions, FireweaveRuntime
from .types import INT_SAFE_MAX_ABS, SHUTDOWN_TIMEOUT_MS_DEFAULT, FlagType, JsonValue

__all__ = [
    "FireweaveClient",
    "ReleaseContext",
    "ReleaseResult",
    "ExposureResult",
    "FlushResult",
    "SignalResult",
    "CapabilityResult",
]

# Telemetry attribute allowlist (architecture §6: no arbitrary PII on wire).
_SIGNAL_ATTRIBUTE_ALLOWLIST = frozenset(
    {
        "name",
        "kind",
        "status",
        "value",
        "unit",
        "rolloutId",
        "changeId",
        "stampId",
        "errorKind",
        "message",
        "flagKey",
        "variant",
        "environment",
        "service",
    }
)

_SIGNAL_KINDS = frozenset({"health", "error", "metric", "outcome"})

# Release-context validation (ruling 15: exactly the required fields of
# spec/release-context.schema.json — rolloutId AND stampIds; typed-ULID
# patterns for stampIds/changeId; no additional requirements).
_CHANGE_ID_RE = re.compile(r"^chg_[0-9A-HJKMNP-TV-Z]{26}$")
_STAMP_ID_RE = re.compile(r"^stmp_[0-9A-HJKMNP-TV-Z]{26}$")
_ROLLOUT_ID_MAX_LEN = 128
_STAMP_IDS_MAX = 64


@dataclass(frozen=True)
class ReleaseContext:
    """Typed release identity (spec/release-context.schema.json)."""

    rollout_id: str
    change_id: Optional[str] = None
    stamp_ids: Tuple[str, ...] = ()

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"rolloutId": self.rollout_id}
        if self.change_id is not None:
            out["changeId"] = self.change_id
        if self.stamp_ids:
            out["stampIds"] = list(self.stamp_ids)
        return out


@dataclass(frozen=True)
class ReleaseResult:
    ok: bool
    status: Optional[str] = None
    reason: Optional[str] = None
    release_context: Optional[ReleaseContext] = None
    degraded: bool = False
    error_kind: Optional[ErrorKind] = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None


@dataclass(frozen=True)
class ExposureResult:
    ok: bool
    queued: int
    deduped: bool = False
    degraded: bool = False
    error_kind: Optional[ErrorKind] = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None


@dataclass(frozen=True)
class FlushResult:
    ok: bool
    flushed: int
    queued: int
    degraded: bool = False
    error_kind: Optional[ErrorKind] = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None


@dataclass(frozen=True)
class SignalResult:
    ok: bool
    accepted: bool
    recorded: Dict[str, Any] = field(default_factory=dict)
    degraded: bool = False
    error_kind: Optional[ErrorKind] = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None


@dataclass(frozen=True)
class CapabilityResult:
    ok: bool
    value: Any = None
    degraded: bool = False
    error_kind: Optional[ErrorKind] = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None


def _gated_release(err: FireweaveError) -> ReleaseResult:
    return ReleaseResult(
        ok=False,
        degraded=True,
        error_kind=err.kind,
        error_code=err.openfeature_error_code,
        error_message=err.message,
    )


def _validate_release_context(
    rollout_id: Any, change_id: Any, stamp_ids: Sequence[Any]
) -> Optional[str]:
    """Ruling 15: enforce exactly spec/release-context.schema.json.

    Returns a safe validation message, or ``None`` when valid.
    """
    if not isinstance(rollout_id, str) or not rollout_id:
        return "release context requires a rolloutId"
    if len(rollout_id) > _ROLLOUT_ID_MAX_LEN:
        return "invalid release context"
    stamp_list = list(stamp_ids)
    if not stamp_list:
        return "release context requires stampIds"
    if len(stamp_list) > _STAMP_IDS_MAX or len(set(stamp_list)) != len(stamp_list):
        return "invalid release context"
    for stamp in stamp_list:
        if not isinstance(stamp, str) or not _STAMP_ID_RE.match(stamp):
            return "invalid release context"
    if change_id is not None and (
        not isinstance(change_id, str) or not _CHANGE_ID_RE.match(change_id)
    ):
        return "invalid release context"
    return None


class _ReleasesNamespace:
    def __init__(self, client: "FireweaveClient") -> None:
        self._client = client
        self._lock = threading.Lock()
        self._context: Optional[ReleaseContext] = None
        self._status: Dict[str, str] = {}
        self._fail_reason: Dict[str, str] = {}

    def _deliver(self, status: str, ctx_dict: Dict[str, Any]) -> None:
        """Best-effort delivery to the adapter sink (ruling 17)."""
        sink = getattr(self._client.runtime.adapter, "deliver_release", None)
        if callable(sink):
            try:
                sink(dict(ctx_dict, status=status))
            except Exception:
                # Telemetry loss must never affect callers.
                pass

    def set_context(
        self,
        rollout_id: str,
        change_id: Optional[str] = None,
        stamp_ids: Sequence[str] = (),
    ) -> ReleaseResult:
        gate = self._client.runtime.lifecycle_gate()
        if gate is not None:
            return _gated_release(gate)
        problem = _validate_release_context(rollout_id, change_id, stamp_ids)
        if problem is not None:
            return ReleaseResult(
                ok=False,
                error_kind=ErrorKind.CONFIGURATION,
                error_code="GENERAL",
                error_message=problem,
            )
        ctx = ReleaseContext(rollout_id, change_id, tuple(stamp_ids))
        with self._lock:
            self._context = ctx
        self._deliver("context_set", ctx.to_dict())
        return ReleaseResult(ok=True, release_context=ctx)

    def _resolve_rollout(self, rollout_id: Optional[str]) -> Optional[str]:
        if rollout_id:
            return rollout_id
        with self._lock:
            return self._context.rollout_id if self._context else None

    def _transition(
        self, rollout_id: Optional[str], status: str, reason: Optional[str] = None
    ) -> ReleaseResult:
        gate = self._client.runtime.lifecycle_gate()
        if gate is not None:
            return _gated_release(gate)
        resolved = self._resolve_rollout(rollout_id)
        if resolved is None:
            return ReleaseResult(
                ok=False,
                error_kind=ErrorKind.CONFIGURATION,
                error_code="GENERAL",
                error_message="no release context bound",
            )
        safe_reason = redact_secrets(reason)
        with self._lock:
            self._status[resolved] = status
            if safe_reason is not None:
                self._fail_reason[resolved] = safe_reason
            bound = self._context
        event: Dict[str, Any] = (
            bound.to_dict() if bound is not None and bound.rollout_id == resolved
            else {"rolloutId": resolved}
        )
        if safe_reason is not None:
            event["reason"] = safe_reason
        self._deliver(status, event)
        return ReleaseResult(ok=True, status=status, reason=safe_reason)

    def start(self, rollout_id: Optional[str] = None) -> ReleaseResult:
        return self._transition(rollout_id, "in_progress")

    def complete(self, rollout_id: Optional[str] = None) -> ReleaseResult:
        return self._transition(rollout_id, "completed")

    def fail(
        self, rollout_id: Optional[str] = None, reason: Optional[str] = None
    ) -> ReleaseResult:
        return self._transition(rollout_id, "failed", reason)

    @property
    def context(self) -> Optional[ReleaseContext]:
        with self._lock:
            return self._context

    def status_of(self, rollout_id: str) -> Optional[str]:
        with self._lock:
            return self._status.get(rollout_id)

    def seed_status(self, rollout_id: str, status: str) -> None:
        """Test/conformance hook: preload a release status."""
        with self._lock:
            self._status[rollout_id] = status


class _ExposuresNamespace:
    """Exposure queue with (targetingKey, flagKey, variant, value) dedup."""

    def __init__(self, client: "FireweaveClient") -> None:
        self._client = client
        self._lock = threading.Lock()
        self._queue: List[Dict[str, Any]] = []
        self._seen: set = set()
        self._flushed_total = 0

    @staticmethod
    def _dedup_key(
        targeting_key: str, flag_key: str, variant: Optional[str], value: JsonValue
    ) -> Tuple[str, str, Optional[str], str]:
        return (
            targeting_key,
            flag_key,
            variant,
            json.dumps(value, sort_keys=True, separators=(",", ":")),
        )

    def record(
        self,
        targeting_key: str,
        flag_key: str,
        variant: Optional[str] = None,
        value: JsonValue = None,
        rollout_id: Optional[str] = None,
    ) -> ExposureResult:
        gate = self._client.runtime.lifecycle_gate()
        if gate is not None:
            return ExposureResult(
                ok=False,
                queued=self.queued,
                degraded=True,
                error_kind=gate.kind,
                error_code=gate.openfeature_error_code,
                error_message=gate.message,
            )
        key = self._dedup_key(targeting_key, flag_key, variant, value)
        event: Dict[str, Any] = {
            "targetingKey": targeting_key,
            "flagKey": flag_key,
            "variant": variant,
            "value": value,
        }
        if rollout_id is not None:
            event["rolloutId"] = rollout_id
        with self._lock:
            if key in self._seen:
                return ExposureResult(ok=True, queued=len(self._queue), deduped=True)
            self._seen.add(key)
            self._queue.append(event)
            return ExposureResult(ok=True, queued=len(self._queue), deduped=False)

    def flush(self) -> FlushResult:
        gate = self._client.runtime.lifecycle_gate()
        if gate is not None:
            return FlushResult(
                ok=False,
                flushed=0,
                queued=self.queued,
                degraded=True,
                error_kind=gate.kind,
                error_code=gate.openfeature_error_code,
                error_message=gate.message,
            )
        with self._lock:
            drained = list(self._queue)
            self._queue.clear()
            self._seen.clear()
            self._flushed_total += len(drained)
        sink = getattr(self._client.runtime.adapter, "send_exposures", None)
        if callable(sink) and drained:
            try:
                sink(drained)
            except Exception:
                # Telemetry loss is acceptable; evaluation paths are unaffected.
                pass
        return FlushResult(ok=True, flushed=len(drained), queued=0)

    def seed(self, events: Sequence[Dict[str, Any]]) -> None:
        """Test/conformance hook: preload the queue (dedup keys included)."""
        with self._lock:
            for event in events:
                key = self._dedup_key(
                    event.get("targetingKey", ""),
                    event.get("flagKey", ""),
                    event.get("variant"),
                    event.get("value"),
                )
                if key not in self._seen:
                    self._seen.add(key)
                    self._queue.append(dict(event))

    @property
    def queued(self) -> int:
        with self._lock:
            return len(self._queue)


class _SignalsNamespace:
    def __init__(self, client: "FireweaveClient") -> None:
        self._client = client
        self._lock = threading.Lock()
        self._recorded: List[Dict[str, Any]] = []

    def _record(self, kind: str, name: str, **attributes: Any) -> SignalResult:
        gate = self._client.runtime.lifecycle_gate()
        if gate is not None:
            return SignalResult(
                ok=False,
                accepted=False,
                degraded=True,
                error_kind=gate.kind,
                error_code=gate.openfeature_error_code,
                error_message=gate.message,
            )
        if kind not in _SIGNAL_KINDS:
            return SignalResult(
                ok=False,
                accepted=False,
                degraded=True,
                error_kind=ErrorKind.UNSUPPORTED_CAPABILITY,
                error_code="GENERAL",
                error_message="unsupported signal kind",
            )
        signal: Dict[str, Any] = {"kind": kind, "name": name}
        for key, value in attributes.items():
            if value is None:
                continue
            if key not in _SIGNAL_ATTRIBUTE_ALLOWLIST:
                continue  # allowlist: silently drop non-canonical attributes
            if isinstance(value, str):
                value = redact_secrets(value)
            signal[key] = value
        with self._lock:
            self._recorded.append(signal)
        # Ruling 17: deliver to the adapter sink, best-effort.
        sink = getattr(self._client.runtime.adapter, "deliver_signal", None)
        if callable(sink):
            try:
                sink(dict(signal))
            except Exception:
                # Telemetry loss must never affect callers.
                pass
        return SignalResult(ok=True, accepted=True, recorded=dict(signal))

    def record_health(
        self,
        name: str,
        status: str,
        rollout_id: Optional[str] = None,
        stamp_id: Optional[str] = None,
    ) -> SignalResult:
        return self._record(
            "health", name, status=status, rolloutId=rollout_id, stampId=stamp_id
        )

    def record_error(
        self,
        name: str,
        error_kind: Optional[str] = None,
        message: Optional[str] = None,
        rollout_id: Optional[str] = None,
    ) -> SignalResult:
        return self._record(
            "error", name, errorKind=error_kind, message=message, rolloutId=rollout_id
        )

    def record_metric(
        self,
        name: str,
        value: float,
        unit: Optional[str] = None,
        rollout_id: Optional[str] = None,
        stamp_id: Optional[str] = None,
    ) -> SignalResult:
        return self._record(
            "metric",
            name,
            value=value,
            unit=unit,
            rolloutId=rollout_id,
            stampId=stamp_id,
        )

    def record_outcome(
        self,
        name: str,
        status: str,
        rollout_id: Optional[str] = None,
        change_id: Optional[str] = None,
    ) -> SignalResult:
        return self._record(
            "outcome", name, status=status, rolloutId=rollout_id, changeId=change_id
        )

    @property
    def recorded(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [dict(s) for s in self._recorded]


class _GuardrailsNamespace:
    """Phase-one stub: every guardrail op degrades with UnsupportedCapability."""

    @staticmethod
    def _degraded() -> CapabilityResult:
        err = UnsupportedCapabilityError()
        return CapabilityResult(
            ok=False,
            degraded=True,
            error_kind=err.kind,
            error_code=err.openfeature_error_code,
            error_message=err.message,
        )

    def check(self, *args: Any, **kwargs: Any) -> CapabilityResult:
        return self._degraded()

    def evaluate(self, *args: Any, **kwargs: Any) -> CapabilityResult:
        return self._degraded()


# runtime.backend enum per spec/capabilities.schema.json.
_KNOWN_BACKENDS = frozenset({"posthog", "inmemory", "none", "other"})


class _CapabilitiesNamespace:
    def __init__(self, client: "FireweaveClient", registry: CapabilityRegistry) -> None:
        self._client = client
        self._registry = registry

    def names(self) -> List[str]:
        """Negotiated capability names in canonical order."""
        return self._registry.get()

    def get(self) -> Dict[str, Any]:
        """Structured static/runtime capability matrix (ruling 18).

        Shape: ``spec/capabilities.schema.json`` — never a flat name list;
        use :meth:`names` for the negotiated capability-name list.
        """
        runtime = self._client.runtime
        adapter = runtime.adapter
        registry = self._registry

        backend = getattr(adapter, "backend_name", "other")
        if backend not in _KNOWN_BACKENDS:
            backend = "other"

        runtime_features: Dict[str, bool] = {}
        features_fn = getattr(adapter, "runtime_features", None)
        if callable(features_fn):
            try:
                runtime_features = {
                    k: bool(v) for k, v in dict(features_fn()).items()
                }
            except Exception:
                runtime_features = {}

        return {
            "static": {
                "language": "python",
                "sdkVersion": __version__,
                "specVersion": SPEC_VERSION,
                "openFeature": {
                    "specFloor": OPENFEATURE_SPEC_FLOOR,
                    "providerName": "fireweave",
                    "serverOnly": True,
                },
                "features": {
                    "flags": True,
                    "releases": registry.supports("releases.setContext"),
                    "exposures": registry.supports("exposures.record"),
                    "signals": registry.supports("signals.recordHealth"),
                    "guardrails": False,
                    "inMemoryAdapter": True,
                    "posthogAdapter": importlib.util.find_spec("posthog") is not None,
                },
            },
            "runtime": {
                "backend": backend,
                "lifecycle": runtime.state.name,
                "features": runtime_features,
                "limits": {
                    "intSafeMaxAbs": INT_SAFE_MAX_ABS,
                    "shutdownTimeoutMsDefault": SHUTDOWN_TIMEOUT_MS_DEFAULT,
                },
            },
        }

    def invoke(self, capability: str, **args: Any) -> CapabilityResult:
        """Dynamic capability invocation; degrades instead of throwing."""
        invoker = self._registry.invoker(capability)
        if invoker is None:
            err = UnsupportedCapabilityError()
            return CapabilityResult(
                ok=False,
                degraded=True,
                error_kind=err.kind,
                error_code=err.openfeature_error_code,
                error_message=err.message,
            )
        try:
            return CapabilityResult(ok=True, value=invoker(**args))
        except Exception:
            err = UnsupportedCapabilityError("capability invocation failed")
            return CapabilityResult(
                ok=False,
                degraded=True,
                error_kind=err.kind,
                error_code=err.openfeature_error_code,
                error_message=err.message,
            )


class _FlagsNamespace:
    """Typed evaluation helpers on the Fireweave-native surface."""

    def __init__(self, client: "FireweaveClient") -> None:
        self._client = client

    def _eval(
        self,
        flag_key: str,
        flag_type: FlagType,
        default: Any,
        context: Optional[EvaluationContext],
        *,
        include_payload: bool = False,
        send_exposure: bool = False,
    ) -> Decision:
        return self._client.runtime.evaluate(
            flag_key,
            flag_type,
            default,
            context,
            EvaluationOptions(
                include_payload=include_payload, send_exposure=send_exposure
            ),
        )

    def get_boolean_value(
        self, flag_key: str, default: bool, context: Optional[EvaluationContext] = None
    ) -> bool:
        return self._eval(flag_key, FlagType.BOOLEAN, default, context).value

    def get_string_value(
        self, flag_key: str, default: str, context: Optional[EvaluationContext] = None
    ) -> str:
        return self._eval(flag_key, FlagType.STRING, default, context).value

    def get_integer_value(
        self, flag_key: str, default: int, context: Optional[EvaluationContext] = None
    ) -> int:
        return self._eval(flag_key, FlagType.INTEGER, default, context).value

    def get_float_value(
        self, flag_key: str, default: float, context: Optional[EvaluationContext] = None
    ) -> float:
        return self._eval(flag_key, FlagType.FLOAT, default, context).value

    def get_object_value(
        self, flag_key: str, default: JsonValue, context: Optional[EvaluationContext] = None
    ) -> JsonValue:
        return self._eval(flag_key, FlagType.OBJECT, default, context).value

    def get_details(
        self,
        flag_key: str,
        flag_type: FlagType,
        default: Any,
        context: Optional[EvaluationContext] = None,
        *,
        include_payload: bool = False,
        send_exposure: bool = False,
    ) -> Decision:
        return self._eval(
            flag_key,
            flag_type,
            default,
            context,
            include_payload=include_payload,
            send_exposure=send_exposure,
        )

    def evaluate(
        self,
        flag_key: str,
        flag_type: FlagType,
        default: Any,
        context: Optional[EvaluationContext] = None,
        *,
        include_payload: bool = False,
        send_exposure: bool = False,
    ) -> Decision:
        """Decision-returning evaluate (architecture ``flags.evaluate`` / ruling 16).

        Alias of :meth:`get_details` for portable FireweaveClient-only call sites.
        """
        return self.get_details(
            flag_key,
            flag_type,
            default,
            context,
            include_payload=include_payload,
            send_exposure=send_exposure,
        )


class FireweaveClient:
    """Top-level Fireweave client: evaluation + release-safety extensions.

    No hidden globals: callers construct the adapter and runtime (or pass an
    adapter and let the client build the runtime), so tests inject fakes.
    """

    def __init__(
        self,
        runtime: FireweaveRuntime,
        *,
        capabilities: Optional[CapabilityRegistry] = None,
    ) -> None:
        self._runtime = runtime
        registry = capabilities or CapabilityRegistry()
        self.flags = _FlagsNamespace(self)
        self.releases = _ReleasesNamespace(self)
        self.exposures = _ExposuresNamespace(self)
        self.signals = _SignalsNamespace(self)
        self.guardrails = _GuardrailsNamespace()
        self.capabilities = _CapabilitiesNamespace(self, registry)
        self._register_capabilities(registry)
        self._shutdown_lock = threading.Lock()
        self._closed = False

    def _register_capabilities(self, registry: CapabilityRegistry) -> None:
        registry.register("releases.setContext", self.releases.set_context)
        registry.register("releases.start", self.releases.start)
        registry.register("releases.complete", self.releases.complete)
        registry.register("releases.fail", self.releases.fail)
        registry.register("exposures.record", self.exposures.record)
        registry.register("exposures.flush", self.exposures.flush)
        registry.register("signals.recordHealth", self.signals.record_health)
        registry.register("signals.recordError", self.signals.record_error)
        registry.register("signals.recordMetric", self.signals.record_metric)
        registry.register("signals.recordOutcome", self.signals.record_outcome)
        registry.register("capabilities.get", self.capabilities.get)

    @property
    def runtime(self) -> FireweaveRuntime:
        return self._runtime

    def initialize(self, *, backend_required: bool = False) -> None:
        self._runtime.initialize(backend_required=backend_required)

    def set_context(self, context: Optional[EvaluationContext]) -> None:
        """Bind the client-layer evaluation context (merge order: middle)."""
        self._runtime.set_client_context(context)

    def shutdown(self, timeout_ms: Optional[int] = None) -> None:
        """Deterministic shutdown: flush exposures, then close the adapter.

        Idempotent and never raises; evaluations after shutdown return
        defaults with ``AlreadyClosed``.
        """
        with self._shutdown_lock:
            if self._closed:
                return
            self._closed = True
        try:
            self.exposures.flush()
        except Exception:
            pass
        self._runtime.shutdown(timeout_ms)

    def __enter__(self) -> "FireweaveClient":
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.shutdown()
