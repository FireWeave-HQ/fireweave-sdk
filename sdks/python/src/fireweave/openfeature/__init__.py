"""OpenFeature integration (requires the ``fireweave[openfeature]`` extra).

Pre-1.0 caveat (ADR-0003): openfeature-sdk is pinned ``>=0.10,<0.11``; every
import of the vendor SDK is isolated inside this subpackage so the Fireweave
core never depends on it.
"""

from .provider import FireweaveProvider

__all__ = ["FireweaveProvider"]
