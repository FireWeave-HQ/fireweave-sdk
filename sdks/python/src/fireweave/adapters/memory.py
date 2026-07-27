"""Deterministic in-memory adapter (fixture-shaped flag definitions).

Resolution is purely definition-driven — no hashing, no percentage bucketing.
A flag definition is a dict in the shape used by ``contracts/`` fixtures:

.. code-block:: python

    {
        "type": "boolean",            # boolean|string|integer|float|object
        "enabled": True,
        "variant": "on",
        "value": True,
        "payload": {...},              # optional
        "reason": {"code": "condition_match", "condition_index": 0, ...},
        "metadata": {"version": 1, "id": 42},
        "fireweaveReason": "SPLIT",   # optional canonical reason override
        "fromCache": False,            # optional stale-cache marker
        "matchTargetingKey": "...",   # optional deterministic conditions
        "matchAttribute": {...},
        "matchPerson": {...},
        "matchGroups": {...},
    }
"""

from __future__ import annotations

import threading
from typing import Any, Dict, Mapping, Optional

from ..context import EvaluationContext
from ..errors import FlagNotFoundError
from .base import FlagResolution

__all__ = ["InMemoryAdapter"]


class InMemoryAdapter:
    """Fixture-driven adapter; thread-safe; supports live flag replacement."""

    def __init__(self, flags: Optional[Mapping[str, Dict[str, Any]]] = None) -> None:
        self._lock = threading.Lock()
        self._flags: Dict[str, Dict[str, Any]] = dict(flags or {})
        self._closed = False

    def initialize(self) -> None:
        with self._lock:
            self._closed = False

    def set_flags(self, flags: Mapping[str, Dict[str, Any]]) -> None:
        with self._lock:
            self._flags = dict(flags)

    def resolve(self, flag_key: str, context: EvaluationContext) -> FlagResolution:
        with self._lock:
            definition = self._flags.get(flag_key)
        if definition is None:
            raise FlagNotFoundError()

        matched = self._conditions_match(definition, context)
        reason = definition.get("reason") or {}
        metadata = definition.get("metadata") or {}
        return FlagResolution(
            value=definition.get("value"),
            variant=definition.get("variant"),
            enabled=bool(definition.get("enabled", True)),
            matched=matched,
            version=metadata.get("version"),
            vendor_flag_id=metadata.get("id"),
            reason_code=reason.get("code"),
            condition_index=reason.get("condition_index"),
            payload=definition.get("payload"),
            fireweave_reason=definition.get("fireweaveReason"),
            from_cache=bool(definition.get("fromCache", False)),
        )

    @staticmethod
    def _conditions_match(
        definition: Mapping[str, Any], context: EvaluationContext
    ) -> bool:
        """All present match* conditions must hold (deterministic equality)."""
        expected_key = definition.get("matchTargetingKey")
        if expected_key is not None and context.targeting_key != expected_key:
            return False

        attrs = dict(context.attributes)

        for cond_field in ("matchAttribute", "matchPerson"):
            conditions = definition.get(cond_field)
            if conditions:
                for key, expected in conditions.items():
                    if attrs.get(key) != expected:
                        return False

        match_groups = definition.get("matchGroups")
        if match_groups:
            groups = context.groups
            for group_type, expected in match_groups.items():
                if groups.get(group_type) != expected:
                    return False
        return True

    def shutdown(self, timeout_ms: int) -> None:
        with self._lock:
            self._closed = True
