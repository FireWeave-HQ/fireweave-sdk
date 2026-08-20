"""FireweaveClient — control-point evaluation and target registration
(spec/control-points.md): the only two v1 capabilities. Facade methods
degrade instead of raising.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass
from typing import Any, FrozenSet, Optional

from ..domain.context import EvaluationContext
from ..domain.decision import Decision
from ..domain.errors import ErrorKind, FireweaveError, UnsupportedCapabilityError
from ..domain.types import FlagType, JsonValue
from .ports import RegisterTargetOptions, RegisterTargetResult
from .runtime import FireweaveRuntime

__all__ = ["FireweaveClient", "ExtensionResult"]


@dataclass(frozen=True)
class ExtensionResult:
    """Result of :meth:`FireweaveClient.invoke_capability`."""

    ok: bool
    error_kind: Optional[ErrorKind] = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None
    degraded: bool = False


def _failure(err: FireweaveError, degraded: bool = False) -> ExtensionResult:
    return ExtensionResult(
        ok=False,
        error_kind=err.kind,
        error_code=err.openfeature_error_code,
        error_message=err.message,
        degraded=degraded,
    )


class _ControlPointsNamespace:
    """Typed evaluation helpers — the nine methods (spec/control-points.md
    "The nine methods"). Documented as ``client.control_points``;
    ``client.flags`` is an identical alias retained for compatibility.
    """

    def __init__(self, runtime: FireweaveRuntime) -> None:
        self._runtime = runtime

    def evaluate(
        self,
        flag_key: str,
        flag_type: FlagType,
        default: Any,
        context: Optional[EvaluationContext] = None,
        options: Optional[Any] = None,
    ) -> Decision:
        """Evaluate a flag to a canonical Decision — the general form the
        eight ``get_*`` methods delegate to.

        ``options`` is reserved for cross-language surface parity
        (conformance/surface/control-points.surface.json pins
        ``evaluate(key, type, default, context?, options?)`` across every
        language) — currently INERT, accepted and typed, nothing reads it.
        The python control-point surface is synchronous (server SDK —
        blocking I/O like node's ``await`` is fine), so there is no
        in-flight-call `signal` to carry, and v1 reads are side-effect-free
        by design (no per-call exposure opt-in to carry either).
        """
        del options
        return self._runtime.evaluate(flag_key, flag_type, default, context)

    def get_boolean_value(self, flag_key: str, default: bool, context: Optional[EvaluationContext] = None) -> bool:
        return self.evaluate(flag_key, FlagType.BOOLEAN, default, context).value

    def get_string_value(self, flag_key: str, default: str, context: Optional[EvaluationContext] = None) -> str:
        return self.evaluate(flag_key, FlagType.STRING, default, context).value

    def get_number_value(self, flag_key: str, default: Any, context: Optional[EvaluationContext] = None) -> Any:
        return self.evaluate(flag_key, FlagType.NUMBER, default, context).value

    def get_object_value(
        self, flag_key: str, default: JsonValue, context: Optional[EvaluationContext] = None
    ) -> JsonValue:
        return self.evaluate(flag_key, FlagType.OBJECT, default, context).value

    def get_boolean_details(
        self, flag_key: str, default: bool, context: Optional[EvaluationContext] = None
    ) -> Decision:
        return self.evaluate(flag_key, FlagType.BOOLEAN, default, context)

    def get_string_details(
        self, flag_key: str, default: str, context: Optional[EvaluationContext] = None
    ) -> Decision:
        return self.evaluate(flag_key, FlagType.STRING, default, context)

    def get_number_details(
        self, flag_key: str, default: Any, context: Optional[EvaluationContext] = None
    ) -> Decision:
        return self.evaluate(flag_key, FlagType.NUMBER, default, context)

    def get_object_details(
        self, flag_key: str, default: JsonValue, context: Optional[EvaluationContext] = None
    ) -> Decision:
        return self.evaluate(flag_key, FlagType.OBJECT, default, context)

    def get_integer_value(self, flag_key: str, default: int, context: Optional[EvaluationContext] = None) -> int:
        """Deprecated alias of :meth:`get_number_value`.

        spec/control-points.md fixed the method as **number**, not integer
        (`Decision.value` is `jsonValue`) — python's pre-v1 surface exposed
        `get_integer_value` with no object variant at all
        (conformance/surface/control-points.surface.json). Kept as a
        deprecated, fully-supported alias rather than removed: it emits one
        `DeprecationWarning` per process (see `_note_deprecated_get_integer_value`)
        and delegates to `get_number_value` — no behavior change beyond the
        warning.
        """
        _note_deprecated_get_integer_value()
        return self.get_number_value(flag_key, default, context)


# Names invoke_capability will dispatch instead of degrading with
# UnsupportedCapability. Empty in v1: releases, exposures, signals,
# capabilities discovery, and guardrails are all out of scope
# (spec/control-points.md) and MUST NOT be exposed, so a cut namespace's
# capability string resolves exactly like any other unknown string.
SUPPORTED_CAPABILITIES: FrozenSet[str] = frozenset()

# One notice per process. A per-call warning on a server SDK becomes log spam
# at request volume, which is how deprecation notices get suppressed
# wholesale and then ignored. Unconditional (no env gate): the SDK reads no
# environment variables (spec/modes.md "The SDK reads no environment
# variables", unscoped).
_flags_alias_warned = False
_get_integer_value_warned = False


def _note_deprecated_flags_alias() -> None:
    global _flags_alias_warned
    if _flags_alias_warned:
        return
    _flags_alias_warned = True
    warnings.warn(
        "client.flags has been renamed to client.control_points. "
        "The old name remains fully supported — no migration is required.",
        DeprecationWarning,
        stacklevel=3,
    )


def _note_deprecated_get_integer_value() -> None:
    global _get_integer_value_warned
    if _get_integer_value_warned:
        return
    _get_integer_value_warned = True
    warnings.warn(
        "control_points.get_integer_value has been renamed to "
        "control_points.get_number_value (spec/control-points.md: number, "
        "not integer). The old name remains fully supported — no migration "
        "is required.",
        DeprecationWarning,
        stacklevel=3,
    )


class FireweaveClient:
    """Top-level Fireweave client: control-point evaluation + target
    registration — the only two v1 capabilities (spec/control-points.md
    "Scope of v1"). No hidden globals: callers construct the runtime (or go
    through `init_fireweave`), so tests inject fakes.
    """

    def __init__(self, runtime: FireweaveRuntime) -> None:
        self._runtime = runtime
        self.control_points = _ControlPointsNamespace(runtime)

    @property
    def flags(self) -> _ControlPointsNamespace:
        """Control-point evaluation under its former name.

        Identical to :attr:`control_points` — ``client.flags is
        client.control_points``. Not scheduled for removal. Logs one notice
        per process the first time this getter is used.
        """
        _note_deprecated_flags_alias()
        return self.control_points

    @property
    def runtime(self) -> FireweaveRuntime:
        return self._runtime

    def initialize(self) -> None:
        self._runtime.initialize()

    def set_context(self, context: Optional[EvaluationContext]) -> None:
        """Bind the client-layer evaluation context (merge order: middle)."""
        self._runtime.set_client_context(context)

    def register_target(
        self, targeting_key: str, options: Optional[RegisterTargetOptions] = None
    ) -> RegisterTargetResult:
        """Register durable targeting facts for a target (spec/modes.md).

        Resolves ``ok=False`` rather than raising: this runs in sign-in
        paths, where a targeting concern must not break authentication. In
        local mode this records in-process and traces the call; nothing
        reaches fw-server (see `FireweaveLocalAdapter.register_target`).
        """
        return self._runtime.register_target(targeting_key, options)

    def invoke_capability(self, capability: str, **args: Any) -> ExtensionResult:
        """Dynamic capability dispatch. Unknown capabilities — currently all
        of them, v1's SUPPORTED_CAPABILITIES is empty — degrade with
        UnsupportedCapability, never raise."""
        del args
        if capability not in SUPPORTED_CAPABILITIES:
            return _failure(UnsupportedCapabilityError(), degraded=True)
        gate = self._runtime.lifecycle_gate()
        if gate is not None:
            return _failure(gate, degraded=True)
        return ExtensionResult(ok=True)

    def shutdown(self) -> None:
        self._runtime.shutdown()

    def __enter__(self) -> "FireweaveClient":
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.shutdown()
