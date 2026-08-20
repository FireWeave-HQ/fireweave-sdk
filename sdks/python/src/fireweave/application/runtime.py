"""FireweaveRuntime: shared engine behind FireweaveClient. Owns lifecycle
state machine, context layering, and the evaluation pipeline. Reads never
raise: evaluation always returns a :class:`Decision`
(spec/control-points.md "Return discipline").
"""

from __future__ import annotations

import enum
import threading
from typing import Optional

from ..domain.context import ContextLimits, DEFAULT_RESERVED_ATTRIBUTE_KEYS, EvaluationContext, merge_contexts
from ..domain.decision import Decision, Reason
from ..domain.errors import (
    FLAG_METADATA_ERROR_KIND_KEY,
    AlreadyClosedError,
    ConfigurationError,
    FireweaveError,
    FlagNotFoundError,
    InternalError,
    NotReadyError,
    TypeMismatchError,
    UnsupportedCapabilityError,
)
from ..domain.types import FlagMetadata, FlagType
from ..domain.validation import (
    matches_expected_type,
    validate_context,
    validate_control_point_key,
    validate_default_value,
)
from .ports import BackendAdapter, FlagResolution, RegisterTargetOptions, RegisterTargetResult

__all__ = ["LifecycleState", "FireweaveRuntime", "DEFAULT_SHUTDOWN_TIMEOUT_MS"]

# Default bound on shutdown (matches node's DEFAULT_SHUTDOWN_TIMEOUT_MS).
DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000


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


class FireweaveRuntime:
    """Owns lifecycle, context layering, and the evaluation pipeline."""

    def __init__(
        self,
        adapter: BackendAdapter,
        *,
        limits: Optional[ContextLimits] = None,
        reserved_attribute_keys=(),
        require_targeting_key: bool = False,
        shutdown_timeout_ms: int = DEFAULT_SHUTDOWN_TIMEOUT_MS,
        global_context: Optional[EvaluationContext] = None,
    ) -> None:
        self._adapter = adapter
        self._limits = limits or ContextLimits()
        self._reserved_attribute_keys = tuple(DEFAULT_RESERVED_ATTRIBUTE_KEYS) + tuple(reserved_attribute_keys)
        self._require_targeting_key = require_targeting_key
        self._shutdown_timeout_ms = shutdown_timeout_ms
        self._global_context = global_context
        self._client_context: Optional[EvaluationContext] = None
        self._state = LifecycleState.UNINITIALIZED
        self._lock = threading.RLock()
        self._init_error: Optional[FireweaveError] = None

    # -- lifecycle -----------------------------------------------------------

    @property
    def state(self) -> LifecycleState:
        with self._lock:
            return self._state

    @property
    def adapter(self) -> BackendAdapter:
        return self._adapter

    def initialize(self) -> None:
        """Transition UNINITIALIZED -> READY; FATAL on configuration failure.

        Raises the underlying :class:`FireweaveError` so `init_fireweave`
        (application/mode.py) can propagate it — initialisation fails loudly
        (spec/modes.md); the runtime state is updated first so later
        evaluations degrade safely.
        """
        with self._lock:
            if self._state is LifecycleState.SHUTDOWN:
                raise AlreadyClosedError()
            if self._state is LifecycleState.READY:
                return
            self._state = LifecycleState.INITIALIZING
        try:
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
        """Extension-call lifecycle gate (kept for `invoke_capability`, even
        though SUPPORTED_CAPABILITIES is empty in v1 and never reaches it
        today): READY/STALE pass (``None``); after shutdown the gate is
        ``AlreadyClosed``; any pre-ready state degrades with
        ``UnsupportedCapability``. Callers convert the returned error into a
        structured result — extension APIs never raise for lifecycle
        reasons."""
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
        """Test hook: pin the lifecycle state."""
        with self._lock:
            self._state = state

    def shutdown(self) -> None:
        """Deterministic, idempotent shutdown; never raises."""
        with self._lock:
            if self._state is LifecycleState.SHUTDOWN:
                return
            self._state = LifecycleState.SHUTDOWN
        try:
            self._adapter.shutdown(self._shutdown_timeout_ms)
        except Exception:
            # Shutdown must not raise; adapter errors are swallowed by design.
            pass

    # -- context layering -----------------------------------------------------

    def set_global_context(self, context: Optional[EvaluationContext]) -> None:
        with self._lock:
            self._global_context = context

    def set_client_context(self, context: Optional[EvaluationContext]) -> None:
        with self._lock:
            self._client_context = context

    def merged_context(self, invocation: Optional[EvaluationContext]) -> EvaluationContext:
        with self._lock:
            global_ctx, client_ctx = self._global_context, self._client_context
        return merge_contexts(global_ctx, client_ctx, invocation)

    # -- target registration ---------------------------------------------------

    def register_target(
        self,
        targeting_key: str,
        options: Optional[RegisterTargetOptions] = None,
    ) -> RegisterTargetResult:
        """Register a user or device so rules can target its durable
        properties. Resolves ``ok=False`` instead of raising: this runs in
        sign-in paths, where a targeting concern must not break
        authentication (spec/modes.md "registerTarget in local mode").
        Adapters without the capability report `UnsupportedCapability`."""
        gate = self._lifecycle_error()
        if gate is not None:
            return RegisterTargetResult(ok=False, error=gate)
        register = getattr(self._adapter, "register_target", None)
        if not callable(register):
            return RegisterTargetResult(ok=False, error=UnsupportedCapabilityError())
        return register(targeting_key, options)

    def _lifecycle_error(self) -> Optional[FireweaveError]:
        """Evaluation/registration lifecycle gate (NotReady / AlreadyClosed)."""
        state = self.state
        if state in (LifecycleState.READY, LifecycleState.STALE):
            return None
        if state is LifecycleState.SHUTDOWN:
            return AlreadyClosedError()
        if state is LifecycleState.FATAL:
            return self._init_error or ConfigurationError()
        return NotReadyError()

    # -- evaluation pipeline -----------------------------------------------------

    def evaluate(
        self,
        flag_key: str,
        flag_type: FlagType,
        default_value,
        invocation_context: Optional[EvaluationContext] = None,
    ) -> Decision:
        """Evaluate a flag. Never raises; failures return the default.

        Validates in the fixed order spec/control-points.md "Validation,
        before any I/O" names, stopping at the first failure: (1) key, (2)
        default vs type, (3) context, (4) lifecycle. Only once all four pass
        does this reach the adapter (the one I/O call in this method).
        """
        key_result = validate_control_point_key(flag_key)
        if not key_result.ok:
            return self._error_decision(default_value, key_result.error)

        default_result = validate_default_value(flag_type, default_value)
        if not default_result.ok:
            return self._error_decision(default_value, default_result.error)

        merged = self.merged_context(invocation_context)
        context_result = validate_context(
            merged,
            limits=self._limits,
            reserved_keys=self._reserved_attribute_keys,
            require_targeting_key=self._require_targeting_key,
        )
        if not context_result.ok:
            return self._error_decision(default_value, context_result.error)
        canonical = context_result.value

        lifecycle_error = self._lifecycle_error()
        if lifecycle_error is not None:
            return self._error_decision(default_value, lifecycle_error)

        try:
            resolution = self._adapter.resolve(flag_key, canonical)
        except FireweaveError as exc:
            return self._error_decision(default_value, exc)
        except Exception as exc:
            wrapped = InternalError("evaluation failed")
            wrapped.__cause__ = exc
            return self._error_decision(default_value, wrapped)

        return self._decision_from_resolution(resolution, flag_type, default_value)

    # -- helpers ---------------------------------------------------------------

    def _decision_from_resolution(
        self,
        resolution: FlagResolution,
        flag_type: FlagType,
        default_value,
    ) -> Decision:
        if not resolution.matched:
            # spec/modes.md "Behaviour per mode": local's unknown-key row is
            # default/reason DEFAULT — deliberately not an error. Any adapter
            # that reports `matched=False` gets this branch (the strict
            # seam); an adapter signalling a genuine backend-side "unknown
            # key" instead RAISES FlagNotFoundError, which is caught above
            # and takes the ERROR branch below.
            return Decision(value=default_value, variant=None, reason=Reason.DEFAULT)

        if not matches_expected_type(resolution.value, flag_type):
            return self._error_decision(default_value, TypeMismatchError())

        value = resolution.value

        if resolution.fireweave_reason:
            reason = resolution.fireweave_reason
        elif not resolution.enabled:
            reason = Reason.DISABLED
        elif resolution.from_cache or self.state is LifecycleState.STALE:
            reason = Reason.STALE
        else:
            reason = Reason.TARGETING_MATCH

        metadata: FlagMetadata = {}
        if resolution.version is not None:
            metadata["fireweave.flagVersion"] = resolution.version
        # Detailed enrichment: only when the backend supplied a flag id, a
        # matched-condition index, AND a reason code together.
        if (
            resolution.vendor_flag_id is not None
            and resolution.condition_index is not None
            and resolution.reason_code is not None
        ):
            metadata["fireweave.vendorFlagId"] = resolution.vendor_flag_id
            metadata["fireweave.reasonCode"] = resolution.reason_code
        if resolution.from_cache:
            metadata["fireweave.fromCache"] = True
        metadata.update(resolution.extra_metadata)

        return Decision(value=value, variant=resolution.variant, reason=reason, flag_metadata=metadata)

    def _error_decision(self, default_value, error: FireweaveError) -> Decision:
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
        )
