"""Concrete backend adapters: local (dev), remote (fw-server), in-memory
(tests/fixtures)."""

from .local import FireweaveLocalAdapter, LocalRegisteredTarget
from .memory import InMemoryAdapter
from .remote import FireweaveRemoteAdapter

__all__ = [
    "FireweaveLocalAdapter",
    "LocalRegisteredTarget",
    "InMemoryAdapter",
    "FireweaveRemoteAdapter",
]
