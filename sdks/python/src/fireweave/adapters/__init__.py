"""Backend adapters: protocol, in-memory, local, remote (default), PostHog (optional)."""

from .base import (
    BackendAdapter,
    FlagResolution,
    RegisterTargetOptions,
    RegisterTargetResult,
    TargetKind,
)
from .local import FireweaveLocalAdapter
from .memory import InMemoryAdapter
from .remote import FireweaveRemoteAdapter

__all__ = [
    "BackendAdapter",
    "FlagResolution",
    "RegisterTargetOptions",
    "RegisterTargetResult",
    "TargetKind",
    "InMemoryAdapter",
    "FireweaveLocalAdapter",
    "FireweaveRemoteAdapter",
]
