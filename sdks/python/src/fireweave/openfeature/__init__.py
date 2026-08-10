"""OpenFeature integration (requires the ``fireweave[openfeature]`` extra).

Pre-1.0 caveat (ADR-0003): openfeature-sdk is pinned ``>=0.10,<0.11``; every
import of the vendor SDK is isolated inside this subpackage so the Fireweave
core never depends on it.
"""

from .local_provider import (
    FwLocalCapture,
    get_fw_local_captures,
    make_fireweave_local_provider,
    reset_fw_local_captures,
)
from .provider import FireweaveProvider

__all__ = [
    "FireweaveProvider",
    "make_fireweave_local_provider",
    "get_fw_local_captures",
    "reset_fw_local_captures",
    "FwLocalCapture",
]
