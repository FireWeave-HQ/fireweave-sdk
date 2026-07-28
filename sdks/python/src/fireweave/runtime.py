"""Shared Fireweave runtime: lifecycle state machine + evaluation pipeline.

Lifecycle (docs/architecture.md):

    UNINITIALIZED -> INITIALIZING -> READY <-> STALE
                                   \\-> ERROR -> READY (recovery)
                                   \\-> FATAL
    any state ----------------------> SHUTDOWN (terminal, idempotent)

The runtime is the single synchronization point: a re-entrant lock guards
state transitions; evaluation reads state without blocking other evaluations.
Evaluation NEVER raises — every failure becomes a default-valued
:class:`~fireweave.decision.Decision` carrying the canonical error kind.
"""

from __future__ import annotations

import enum
import json
import threading
from typing import Any, Dict, Optional

from .adapters.base import BackendAdapter, FlagResolution
from .config import FireweaveConfig
from .context import EvaluationContext, merge_contexts, validate_context
from .decision import Decision, Reason
from .errors import (
    AlreadyClosedError,
    FireweaveError,
    FlagNotFoundError,
    InternalError,
    NotReadyError,
    TypeMismatchError,
    UnsupportedCapabilityError,
    FLAG_METADATA_ERROR_KIND_KEY,
)
from .types import FlagMetadata, FlagType

__all__ = ["LifecycleState", "FireweaveRuntime", "EvaluationOptions"]


class LifecycleState(enum.Enum):
    UNINITIALIZED = "UNINITIALIZED"
    INITIALIZING = "INITIALIZING"
    READY = "READY"
    STALE = "STALE"
    ERROR = "ERROR"
    FATAL = "FATAL"
    SHUTDOWN = "SHUTDOWN"

    @property
    def wire_name(self) -> str:
        """Provider-state name used by contracts fixtures."""
        return {
            LifecycleState.UNINITIALIZED: "NOT_READY",
            LifecycleState.INITIALIZING: "NOT_READY",
            LifecycleState.READY: "READY",
            LifecycleState.STALE: "STALE",
            LifecycleState.ERROR: "ERROR",
            LifecycleState.FATAL: "FATAL",
            LifecycleState.SHUTDOWN: "CLOSED",
        }[self]


class EvaluationOptions:
    """Per-invocation evaluation options.

    ``include_payload`` attaches the flag payload as ``fireweave.payload``
    metadata. ``send_exposure`` requests OF-path exposure emission; the
    phase-one Python PostHog adapter uses side-effect-free snapshot reads, so
    ``True`` is accepted for API portability but does not emit vendor
    ``$feature_flag_called`` on evaluate (use ``exposures.record`` /
    ``exposures.flush``). Default ``False`` matches the ratified phase-one
    side-effect-free evaluate contract (ADR-0001 errata / Agent M H-4).
    """

    __slots__ = ("include_payload", "send_exposure")

    def __init__(
        self, *, include_payload: bool = False, send_exposure: bool = False
    ) -> None:
        self.include_payload = include_payload
        self.send_exposure = send_exposure


_PY_TYPES = {
    FlagType.BOOLEAN: bool,
    FlagType.STRING: str,
}


def _check_type(flag_type: FlagType, value: Any) -> Any:
    """Strict type check with the ratified numeric coercion rules.

    - bool is never accepted for integer/float (Python bool subclasses int).
    - int -> float coercion is allowed; float -> int is a TypeMismatch even
      for integral floats (2.0 requested as integer fails).
    """
    if flag_type is FlagType.BOOLEAN:
        if isinstance(value, bool):
            return value
    elif flag_type is FlagType.STRING:
        if isinstance(value, str):
            return value
    elif flag_type is FlagType.INTEGER:
        if isinstance(value, int) and not isinstance(value, bool):
            return value
    elif flag_type is FlagType.FLOAT:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
    elif flag_type is FlagType.OBJECT:
        if isinstance(value, (dict, list)):
            return value
    raise TypeMismatchError()


class FireweaveRuntime:
    """Owns lifecycle, context layering, and the evaluation pipeline."""

    def __init__(
        self,
        adapter: BackendAdapter,
        config: Optional[FireweaveConfig] = None,
        *,
        global_context: Optional[EvaluationContext] = None,
    ) -> None:
        self._adapter = adapter
        self._config = config or FireweaveConfig()
        self._global_context = global_context
        self._client_context: Optional[EvaluationContext] = None
        self._state = LifecycleState.UNINITIALIZED
        self._lock = threading.RLock()
        self._init_error: Optional[FireweaveError] = None

    # -- lifecycle ---------------------------------------------------------

    @property
    def state(self) -> LifecycleState:
        with self._lock:
            return self._state

    @property
    def config(self) -> FireweaveConfig:
        return self._config

    @property
    def adapter(self) -> BackendAdapter:
        return self._adapter

    def initialize(self, *, backend_required: bool = False) -> None:
        """Transition UNINITIALIZED -> READY; FATAL on configuration failure.

        Raises the underlying :class:`FireweaveError` so callers (e.g. the
        OpenFeature provider ``initialize`` hook) can propagate it; the
        runtime state is updated first so later evaluations degrade safely.
        """
        with self._lock:
            if self._state is LifecycleState.SHUTDOWN:
                raise AlreadyClosedError()
            if self._state is LifecycleState.READY:
                return
            self._state = LifecycleState.INITIALIZING
        try:
            self._config.validate(backend_required=backend_required)
            self._adapter.initialize()
        except FireweaveError as exc:
            with self._lock:
                self._state = LifecycleState.FATAL
                self._init_error = exc
            raise
        except Exception as exc:  # vendor exception: wrap, preserve cause
            wrapped = InternalError("initialization failed")
            wrapped.__cause__ = exc
            with self._lock:
                self._state = LifecycleState.FATAL
                self._init_error = wrapped
            raise wrapped from exc
        with self._lock:
            self._state = LifecycleState.READY
            self._init_error = None

    def lifecycle_gate(self) -> Optional[FireweaveError]:
        """Extension-call lifecycle gate (ruling 17, Go/Java model).

        READY/STALE pass (``None``); after shutdown the gate is
        ``AlreadyClosed``; any pre-ready state degrades with
        ``UnsupportedCapability``. Callers convert the returned error into a
        structured result — extension APIs never raise for lifecycle reasons.
        """
        state = self.state
        if state in (LifecycleState.READY, LifecycleState.STALE):
            return None
        if state is LifecycleState.SHUTDOWN:
            return AlreadyClosedError()
        return UnsupportedCapabilityError()

    def mark_stale(self) -> None:
        with self._lock:
            if self._state is LifecycleState.READY:
                self._state = LifecycleState.STALE

    def force_state(self, state: LifecycleState) -> None:
        """Test/conformance hook: pin the lifecycle state."""
        with self._lock:
            self._state = state

    def shutdown(self, timeout_ms: Optional[int] = None) -> None:
        """Deterministic, idempotent shutdown; never raises."""
        with self._lock:
            if self._state is LifecycleState.SHUTDOWN:
                return
            self._state = LifecycleState.SHUTDOWN
        try:
            self._adapter.shutdown(timeout_ms or self._config.shutdown_timeout_ms)
        except Exception:
            # Shutdown must not throw; adapter errors are swallowed by design.
            pass

    # -- context layering ---------------------------------------------------

    def set_global_context(self, context: Optional[EvaluationContext]) -> None:
        with self._lock:
            self._global_context = context

    def set_client_context(self, context: Optional[EvaluationContext]) -> None:
        with self._lock:
            self._client_context = context

    def merged_context(
        self, invocation: Optional[EvaluationContext]
    ) -> EvaluationContext:
        with self._lock:
            global_ctx, client_ctx = self._global_context, self._client_context
        return merge_contexts(global_ctx, client_ctx, invocation)

    # -- evaluation pipeline -------------------------------------------------

    def evaluate(
        self,
        flag_key: str,
        flag_type: FlagType,
        default_value: Any,
        invocation_context: Optional[EvaluationContext] = None,
        options: Optional[EvaluationOptions] = None,
    ) -> Decision:
        """Evaluate a flag. Never raises; failures return the default."""
        options = options or EvaluationOptions()

        state = self.state
        if state is LifecycleState.SHUTDOWN:
            return self._error_decision(default_value, AlreadyClosedError())
        if state in (LifecycleState.UNINITIALIZED, LifecycleState.INITIALIZING):
            return self._error_decision(default_value, NotReadyError())
        if state is LifecycleState.FATAL:
            err = self._init_error or NotReadyError()
            return self._error_decision(default_value, err)

        merged = self.merged_context(invocation_context)
        try:
            validate_context(
                merged,
                limits=self._config.limits,
                reserved_keys=self._config.reserved_attribute_keys,
                require_targeting_key=self._config.require_targeting_key,
            )
        except FireweaveError as exc:
            return self._error_decision(default_value, exc, merged)

        try:
            resolution = self._adapter.resolve(flag_key, merged)
        except FireweaveError as exc:
            return self._error_decision(default_value, exc, merged)
        except Exception as exc:
            wrapped = InternalError("evaluation failed")
            wrapped.__cause__ = exc
            return self._error_decision(default_value, wrapped, merged)

        return self._decision_from_resolution(
            resolution, flag_type, default_value, merged, options, state
        )

    # -- helpers -------------------------------------------------------------

    def _decision_from_resolution(
        self,
        resolution: FlagResolution,
        flag_type: FlagType,
        default_value: Any,
        merged: EvaluationContext,
        options: EvaluationOptions,
        state: LifecycleState,
    ) -> Decision:
        if not resolution.matched:
            return Decision(
                value=default_value,
                variant=None,
                reason=Reason.DEFAULT,
                resolved_context=self._resolved_context_dict(merged),
            )

        try:
            value = _check_type(flag_type, resolution.value)
        except TypeMismatchError as exc:
            return self._error_decision(default_value, exc, merged)

        if resolution.fireweave_reason:
            reason = resolution.fireweave_reason
        elif not resolution.enabled:
            reason = Reason.DISABLED
        elif resolution.from_cache or state is LifecycleState.STALE:
            reason = Reason.STALE
        else:
            reason = Reason.TARGETING_MATCH

        metadata: FlagMetadata = {}
        if resolution.version is not None:
            metadata["fireweave.flagVersion"] = resolution.version
        # Detailed enrichment: only when the vendor supplied both a flag id
        # and a matched-condition index (see conformance notes).
        if (
            resolution.vendor_flag_id is not None
            and resolution.condition_index is not None
            and resolution.reason_code is not None
        ):
            metadata["fireweave.vendorFlagId"] = resolution.vendor_flag_id
            metadata["fireweave.reasonCode"] = resolution.reason_code
        if options.include_payload and resolution.payload is not None:
            metadata["fireweave.payload"] = json.dumps(
                resolution.payload, sort_keys=True, separators=(",", ":")
            )
        if resolution.from_cache:
            metadata["fireweave.fromCache"] = True
        metadata.update(resolution.extra_metadata)

        return Decision(
            value=value,
            variant=resolution.variant,
            reason=reason,
            flag_metadata=metadata,
            resolved_context=self._resolved_context_dict(merged),
        )

    @staticmethod
    def _resolved_context_dict(merged: EvaluationContext) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        if merged.targeting_key is not None:
            out["targetingKey"] = merged.targeting_key
        plain = merged.plain_attributes
        if plain:
            out["attributes"] = plain
        return out

    def _error_decision(
        self,
        default_value: Any,
        error: FireweaveError,
        merged: Optional[EvaluationContext] = None,
    ) -> Decision:
        metadata: FlagMetadata = {FLAG_METADATA_ERROR_KIND_KEY: error.kind.value}
        if isinstance(error, FlagNotFoundError) and error.quota_limited:
            metadata["fireweave.quotaLimited"] = True
        return Decision(
            value=default_value,
            variant=None,
            reason=Reason.ERROR,
            error_code=error.openfeature_error_code,
            error_message=error.message,
            error_kind=error.kind,
            flag_metadata=metadata,
            resolved_context=(
                self._resolved_context_dict(merged) if merged is not None else None
            ),
        )
