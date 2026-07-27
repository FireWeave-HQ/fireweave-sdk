"""Shared public types for the Fireweave SDK.

No vendor (PostHog) or OpenFeature types appear here — these are the canonical
Fireweave-owned shapes per ``spec/`` v0.1.0.
"""

from __future__ import annotations

import enum
from typing import Dict, List, Union

# JSON-compatible value (spec/decision.schema.json $defs.jsonValue).
JsonValue = Union[None, bool, int, float, str, List["JsonValue"], Dict[str, "JsonValue"]]

# flagMetadata values per OpenFeature: bool | string | number.
FlagMetadataValue = Union[bool, str, int, float]
FlagMetadata = Dict[str, FlagMetadataValue]


class FlagType(enum.Enum):
    """Requested flag value type for typed evaluation."""

    BOOLEAN = "boolean"
    STRING = "string"
    INTEGER = "integer"
    FLOAT = "float"
    OBJECT = "object"


# 2^53 - 1: cross-language safe integer bound (spec/capabilities limits).
INT_SAFE_MAX_ABS = 9007199254740991

# Default shutdown deadline (ms) per architecture §6.1 / capabilities schema.
SHUTDOWN_TIMEOUT_MS_DEFAULT = 10_000
