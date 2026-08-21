"""BackendAdapter protocol and the vendor-neutral resolution/target-registration
records it exchanges with :class:`~fireweave.application.runtime.FireweaveRuntime`.

Adapters translate a backend (fw-server, an in-process dev map, in-memory
fixtures) into :class:`FlagResolution` records. No vendor types cross this
boundary — the runtime and public API only ever see Fireweave-owned shapes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Protocol, runtime_checkable

from ..domain.context import EvaluationContext
from ..domain.errors import FireweaveError
from ..domain.target import TargetKind
from ..domain.types import JsonValue

__all__ = [
    "BackendAdapter",
    "EvaluateOptions",
    "FlagResolution",
    "RegisterTargetOptions",
    "RegisterTargetResult",
]


@dataclass(frozen=True)
class EvaluateOptions:
    """``evaluate()``'s reserved fifth argument
    (conformance/surface/control-points.surface.json:
    ``evaluate(key, type, default, context?, options?)``).

    ``include_payload`` (task-10b item 5, contracts/evaluation/eval-payload-
    attached.json): when True and the resolved flag carries a payload
    (:attr:`FlagResolution.payload`), it is attached to
    ``flag_metadata['fireweave.payload']`` as a deterministic (sorted-key)
    JSON string — matching node's ``EvaluateOptions.includePayload``. Before
    task-10b this was entirely absent (``evaluate()`` had no ``options``
    concept whatsoever; the parameter existed but was always discarded).
    """

    include_payload: bool = False


@dataclass(frozen=True)
class RegisterTargetOptions:
    """Options for ``POST /v1/targets/register`` (spec/remote-register-target).

    Omitted fields are left off the wire rather than sent as null/default —
    the server defaults ``kind`` to ``user`` when absent.
    """

    kind: Optional[TargetKind] = None
    properties: Optional[Dict[str, JsonValue]] = None
    environment: Optional[str] = None


@dataclass(frozen=True)
class RegisterTargetResult:
    """Outcome of target registration.

    ``ok=False`` means the target was NOT registered — rules that depend on
    its properties will not match until a later attempt succeeds. Callers in
    a login path normally ignore this; a careful caller logs it — a silently
    unregistered target is exactly how targeting rules end up matching
    nobody.
    """

    ok: bool
    error: Optional[FireweaveError] = None


@dataclass(frozen=True)
class FlagResolution:
    """Vendor-neutral outcome of resolving one flag.

    ``matched=False`` is the ONE typed channel an adapter uses to signal "no
    decision for this key/context" back to the runtime — it is what
    :meth:`FireweaveRuntime.evaluate` reads to produce reason ``DEFAULT``
    (spec/modes.md "Behaviour per mode": local mode's unknown-key row).
    Contrast a genuinely-unknown key at a real backend (remote's "key unknown
    to the backend" row), which resolves to reason ``ERROR``/``FlagNotFound``
    by *raising* :class:`~fireweave.domain.errors.FlagNotFoundError` instead
    of returning ``matched=False`` — see `FireweaveRemoteAdapter.resolve` and
    `FireweaveLocalAdapter.resolve`.

    ``fireweave_reason`` lets an adapter force a canonical reason on a
    *matched* resolution (e.g. the local dev adapter's ``STATIC``).
    """

    value: JsonValue = None
    variant: Optional[str] = None
    enabled: bool = True
    matched: bool = True
    version: Optional[int] = None
    vendor_flag_id: Optional[int] = None
    reason_code: Optional[str] = None
    condition_index: Optional[int] = None
    payload: Optional[JsonValue] = None
    fireweave_reason: Optional[str] = None
    from_cache: bool = False
    extra_metadata: Dict[str, Any] = field(default_factory=dict)


@runtime_checkable
class BackendAdapter(Protocol):
    """Protocol every Fireweave backend adapter implements.

    ``resolve`` raises a :class:`fireweave.domain.errors.FireweaveError`
    subtype for a genuine backend failure (FlagNotFound, Network, Timeout,
    ...); the runtime converts those into default-valued decisions —
    evaluation APIs never propagate them to the caller.

    ``register_target`` is an OPTIONAL, duck-typed capability (not part of
    this Protocol's required members): the runtime checks
    ``getattr(adapter, "register_target", None)`` and degrades to
    ``UnsupportedCapability`` when absent, mirroring how the node/web
    reference SDKs treat it as an optional adapter surface.
    """

    def initialize(self) -> None:
        """Bring the backend up; raise FireweaveError on fatal config."""

    def resolve(self, flag_key: str, context: EvaluationContext) -> FlagResolution:
        """Resolve one flag against a validated, merged context."""

    def shutdown(self, timeout_ms: int) -> None:
        """Deterministically release resources within ``timeout_ms``.
        Idempotent; must never raise."""
