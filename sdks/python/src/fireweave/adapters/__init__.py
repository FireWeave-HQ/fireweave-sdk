"""Backend adapters: protocol, in-memory, remote (default), and PostHog (optional)."""

from .base import BackendAdapter, FlagResolution
from .memory import InMemoryAdapter
from .remote import FireweaveRemoteAdapter

__all__ = [
    "BackendAdapter",
    "FlagResolution",
    "InMemoryAdapter",
    "FireweaveRemoteAdapter",
]
