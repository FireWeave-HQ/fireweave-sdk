"""Canonical evaluation decision (spec/decision.schema.json)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from .errors import ErrorKind
from .types import FlagMetadata

__all__ = ["Decision", "Reason"]


class Reason:
    """Canonical reason strings (spec/decision.schema.json)."""

    TARGETING_MATCH = "TARGETING_MATCH"
    SPLIT = "SPLIT"
    DISABLED = "DISABLED"
    DEFAULT = "DEFAULT"
    STALE = "STALE"
    CACHED = "CACHED"
    STATIC = "STATIC"
    ERROR = "ERROR"


@dataclass(frozen=True)
class Decision:
    """Result of a flag evaluation. Evaluation APIs return this, never raise
    (spec/control-points.md "Return discipline — never throw into a read
    path")."""

    value: Any
    variant: Optional[str] = None
    reason: str = Reason.DEFAULT
    error_code: Optional[str] = None
    error_message: Optional[str] = None
    error_kind: Optional[ErrorKind] = None
    flag_metadata: FlagMetadata = field(default_factory=dict)

    @property
    def is_error(self) -> bool:
        return self.reason == Reason.ERROR
