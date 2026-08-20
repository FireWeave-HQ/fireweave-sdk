"""Shared public types for the Fireweave SDK.

No vendor-backend or OpenFeature-provider types appear here — these are the
canonical Fireweave-owned shapes per spec/ v0.1.0.
"""

from __future__ import annotations

import enum
from typing import Dict, List, Union

# JSON-compatible value (spec/decision.schema.json $defs.jsonValue).
JsonValue = Union[None, bool, int, float, str, List["JsonValue"], Dict[str, "JsonValue"]]

# flagMetadata values per spec/decision.schema.json: bool | string | number.
FlagMetadataValue = Union[bool, str, int, float]
FlagMetadata = Dict[str, FlagMetadataValue]


class FlagType(str, enum.Enum):
    """Requested flag value type for typed evaluation (spec/control-points.md
    "The nine methods"). Exactly four: boolean, string, number, object —
    there is no separate integer/float distinction in v1 (`Decision.value` is
    `jsonValue`; `getNumberValue` returns **number**, not integer)."""

    BOOLEAN = "boolean"
    STRING = "string"
    NUMBER = "number"
    OBJECT = "object"
