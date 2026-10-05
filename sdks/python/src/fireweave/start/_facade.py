"""``fw``: the singleton accessor beside ``start()``. Safe to import anywhere,
in any order: importing it reads no env, does no I/O and creates no logger.

Every read forwards to the current process client and never raises: if
start failed, reads serve the caller's default (or an ERROR decision for
``evaluate`` and the ``*_details`` forms). Forwarding on every call means a
captured ``fw.control_points`` keeps working across the one-time replacement
of an implicit start and across a fork rebuild.

Every read goes through the core's ``evaluate`` (the value forms return its
``.value``, exactly as the core's own value methods do), so the facade sees
each decision's error kind: a read that loaded the client just before the
one-time replacement shut it down reads again from the new client, and a
fw-server failure in remote mode is reported once per kind (SP-27).
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

from fireweave import (
    Decision,
    ErrorKind,
    EvaluateOptions,
    EvaluationContext,
    FireweaveClient,
    FireweaveError,
    FlagType,
    InternalError,
    InvalidContextError,
    JsonValue,
    Reason,
    RegisterTargetOptions,
    RegisterTargetResult,
    TargetKind,
)

from . import _state
from ._state import FireweaveStatus

# fireweave.domain.errors.FLAG_METADATA_ERROR_KIND_KEY, which the public
# package does not export; start/ may only use the public API.
_ERROR_KIND_KEY = "fireweave.errorKind"


def _error_decision(default: Any, error: FireweaveError) -> Decision:
    """The core runtime's ERROR decision shape."""
    return Decision(
        value=default,
        variant=None,
        reason=Reason.ERROR,
        error_code=error.openfeature_error_code,
        error_message=error.message,
        error_kind=error.kind,
        flag_metadata={_ERROR_KIND_KEY: error.kind.value},
    )


def _as_fireweave_error(exc: Exception) -> FireweaveError:
    if isinstance(exc, FireweaveError):
        return exc
    wrapped = InternalError("evaluation failed")
    wrapped.__cause__ = exc
    return wrapped


def _note_local_key(flag_key: str) -> None:
    """Local mode: a key missing from the flags object gets its default, with
    one warning naming the flags file."""
    local = _state.local_flags()
    if local is None or flag_key in local[0]:
        return
    where = f" ({local[1]})" if local[1] is not None else ""
    _state.warn_once(
        f"[fireweave:local] {flag_key!r} is not in your flags object{where}, so it gets its default. "
        "Add it there to try it locally."
    )


def _read(
    flag_key: str,
    flag_type: FlagType,
    default: Any,
    context: Any,
    options: Optional[EvaluateOptions] = None,
) -> Decision:
    try:
        client = _state.current_client()
        if context is not None and not isinstance(context, EvaluationContext):
            # The core expects an EvaluationContext; anything else is an
            # invalid context, never an exception out of a read.
            return _error_decision(default, InvalidContextError("context must be a fireweave.EvaluationContext"))
        decision = client.control_points.evaluate(flag_key, flag_type, default, context, options)
        if decision.error_kind is ErrorKind.ALREADY_CLOSED:
            # The client was swapped out and shut down between loading it and
            # reading (the first explicit start() after an implicit one): read
            # again from the client now in the slot. After fw.shutdown() the
            # slot still holds the closed client, so this does not retry.
            current = _state.current_client()
            if current is not client:
                decision = current.control_points.evaluate(flag_key, flag_type, default, context, options)
    except Exception as exc:
        return _error_decision(default, _as_fireweave_error(exc))
    _state.observe_error(decision.error_kind)
    _note_local_key(flag_key)
    return decision


class ControlPoints:
    """The same nine read methods, names and arities as the core client's
    ``control_points``, forwarded to the process client."""

    __slots__ = ()

    def evaluate(
        self,
        flag_key: str,
        flag_type: FlagType,
        default: Any,
        context: Optional[EvaluationContext] = None,
        options: Optional[EvaluateOptions] = None,
    ) -> Decision:
        return _read(flag_key, flag_type, default, context, options)

    def get_boolean_value(self, flag_key: str, default: bool, context: Optional[EvaluationContext] = None) -> bool:
        return _read(flag_key, FlagType.BOOLEAN, default, context).value

    def get_string_value(self, flag_key: str, default: str, context: Optional[EvaluationContext] = None) -> str:
        return _read(flag_key, FlagType.STRING, default, context).value

    def get_number_value(self, flag_key: str, default: Any, context: Optional[EvaluationContext] = None) -> Any:
        return _read(flag_key, FlagType.NUMBER, default, context).value

    def get_object_value(
        self, flag_key: str, default: JsonValue, context: Optional[EvaluationContext] = None
    ) -> JsonValue:
        return _read(flag_key, FlagType.OBJECT, default, context).value

    def get_boolean_details(
        self, flag_key: str, default: bool, context: Optional[EvaluationContext] = None
    ) -> Decision:
        return _read(flag_key, FlagType.BOOLEAN, default, context)

    def get_string_details(self, flag_key: str, default: str, context: Optional[EvaluationContext] = None) -> Decision:
        return _read(flag_key, FlagType.STRING, default, context)

    def get_number_details(self, flag_key: str, default: Any, context: Optional[EvaluationContext] = None) -> Decision:
        return _read(flag_key, FlagType.NUMBER, default, context)

    def get_object_details(
        self, flag_key: str, default: JsonValue, context: Optional[EvaluationContext] = None
    ) -> Decision:
        return _read(flag_key, FlagType.OBJECT, default, context)


class Fireweave:
    """The type of ``fw``. There is one instance; import it, never build one."""

    __slots__ = ("control_points",)

    control_points: ControlPoints

    def __init__(self) -> None:
        object.__setattr__(self, "control_points", ControlPoints())

    def __setattr__(self, name: str, value: Any) -> None:
        raise AttributeError("fw is read-only")

    def identify(
        self,
        targeting_key: str,
        properties: Optional[Mapping[str, JsonValue]] = None,
        *,
        kind: TargetKind = "user",
    ) -> RegisterTargetResult:
        """Register durable targeting facts at sign-in (the core's
        ``register_target``). Returns ``ok=False`` instead of raising. It does
        not bind a subject for later reads: pass the targeting key to each
        read. A blocking HTTP call in remote mode."""
        try:
            options = RegisterTargetOptions(
                kind=kind,
                # Not a mapping: passed through for the core to answer
                # InvalidContext, rather than failing here in dict().
                properties=(
                    dict(properties) if isinstance(properties, Mapping) else properties  # type: ignore[arg-type]
                ),
            )
            client = _state.current_client()
            result = client.register_target(targeting_key, options)
            if result.error is not None and result.error.kind is ErrorKind.ALREADY_CLOSED:
                current = _state.current_client()
                if current is not client:
                    result = current.register_target(targeting_key, options)
        except Exception as exc:
            return RegisterTargetResult(ok=False, error=_as_fireweave_error(exc))
        _state.observe_error(result.error.kind if result.error is not None else None)
        return result

    def instance_key(self) -> str:
        """Stable key for reads where the server is the subject (cron, boot):
        ``start(instance_id=...)``, then FIREWEAVE_INSTANCE_ID, then ``inst_``
        plus a hash of the host name. Never applied automatically; nothing is
        written to disk."""
        return _state.instance_key()

    def status(self) -> FireweaveStatus:
        """What start() decided: mode and why, channel, host, key source,
        environment, flag count, error. Never includes the key."""
        return _state.current_status()

    def client(self) -> FireweaveClient:
        """The core client, for anything the facade does not cover. Starts
        FireWeave from the environment if no start() has run. After a failed
        start it is a client whose reads serve defaults (never None, never a
        raise). Do not cache it: the first explicit start() after an implicit
        one, and a fork, replace it."""
        return _state.current_client()

    def shutdown(self) -> None:
        """Flush and close. A later start() begins fresh."""
        _state.shutdown()

    def __repr__(self) -> str:
        return f"<fireweave.start.fw state={_state.current_status().state!r}>"


fw = Fireweave()
