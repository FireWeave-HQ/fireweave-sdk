"""Backend adapters: protocol, in-memory, and PostHog (optional extra)."""

from .base import BackendAdapter, FlagResolution
from .memory import InMemoryAdapter

__all__ = ["BackendAdapter", "FlagResolution", "InMemoryAdapter"]
