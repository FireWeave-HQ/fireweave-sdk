"""BackendAdapter protocol and vendor-neutral resolution record.

Adapters translate a vendor backend (PostHog, in-memory fixtures, ...) into
:class:`FlagResolution` records. No vendor types cross this boundary — the
runtime and public API only ever see Fireweave-owned shapes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Protocol, runtime_checkable

from ..context import EvaluationContext
from ..types import JsonValue

__all__ = ["BackendAdapter", "FlagResolution"]


@dataclass(frozen=True)
class FlagResolution:
    """Vendor-neutral outcome of resolving one flag.

    ``matched`` is False when targeting conditions did not select the caller
    (the runtime then serves the caller default with reason DEFAULT).
    ``fireweave_reason`` lets adapters force a canonical reason (e.g. SPLIT).
    """

    value: JsonValue
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
    quota_limited: bool = False
    extra_metadata: Dict[str, Any] = field(default_factory=dict)


@runtime_checkable
class BackendAdapter(Protocol):
    """Protocol every Fireweave backend adapter implements.

    ``resolve`` raises a :class:`fireweave.errors.FireweaveError` subtype on
    failure (FlagNotFound, Network, Timeout, ...); the runtime converts errors
    into default-valued decisions — evaluation APIs never propagate them.
    """

    def initialize(self) -> None:
        """Bring the backend up; raise FireweaveError on fatal config."""

    def resolve(self, flag_key: str, context: EvaluationContext) -> FlagResolution:
        """Resolve one flag against a validated, merged context."""

    def shutdown(self, timeout_ms: int) -> None:
        """Deterministically flush and release resources within ``timeout_ms``.

        Idempotent; must never block past the deadline.
        """


# Optional adapter surface (duck-typed, ruling 17 / capabilities matrix):
#
# - ``backend_name: str`` — "posthog" | "inmemory" | "none" | "other"
#   (spec/capabilities.schema.json runtime.backend).
# - ``runtime_features() -> Dict[str, bool]`` — adapter-dependent runtime
#   capability booleans merged into ``capabilities.get()``.
# - ``send_exposures(events: list) -> None`` — telemetry sink for flushed
#   exposure events.
# - ``deliver_signal(signal: Dict) -> None`` — telemetry sink for recorded
#   signals.
# - ``deliver_release(event: Dict) -> None`` — telemetry sink for release
#   transitions.
#
# All sink methods are best-effort: implementations swallow vendor errors —
# telemetry loss must never affect callers.
