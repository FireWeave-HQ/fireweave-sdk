"""Capability registry (spec/capabilities.schema.json).

Capabilities are negotiated at construction: the static set below intersected
with what the configured adapter supports. ``capabilities.get()`` returns the
negotiated list; invoking an unregistered capability degrades gracefully with
``UnsupportedCapability`` (never throws from the facade).
"""

from __future__ import annotations

from typing import Callable, Dict, Iterable, List, Optional

__all__ = ["CANONICAL_CAPABILITIES", "CapabilityRegistry"]

# Ordered canonical capability names (contracts/extensions/ext-capabilities-get.json).
CANONICAL_CAPABILITIES: List[str] = [
    "releases.setContext",
    "releases.start",
    "releases.complete",
    "releases.fail",
    "exposures.record",
    "exposures.flush",
    "signals.recordHealth",
    "signals.recordError",
    "signals.recordMetric",
    "signals.recordOutcome",
    "capabilities.get",
]


class CapabilityRegistry:
    """Holds negotiated capabilities and their invokers."""

    def __init__(self, enabled: Optional[Iterable[str]] = None) -> None:
        base = list(enabled) if enabled is not None else list(CANONICAL_CAPABILITIES)
        # Preserve canonical ordering.
        self._enabled: List[str] = [c for c in CANONICAL_CAPABILITIES if c in set(base)]
        self._invokers: Dict[str, Callable[..., object]] = {}

    def register(self, name: str, invoker: Callable[..., object]) -> None:
        """Attach an invoker. Registration does NOT widen the negotiated set:
        a capability disabled at construction stays unavailable (degrades with
        UnsupportedCapability when invoked)."""
        self._invokers[name] = invoker

    def get(self) -> List[str]:
        """Negotiated capability names in canonical order."""
        return list(self._enabled)

    def supports(self, name: str) -> bool:
        return name in self._enabled

    def invoker(self, name: str) -> Optional[Callable[..., object]]:
        if name not in self._enabled:
            return None
        return self._invokers.get(name)
