"""Async story (ADR-0004): sync core + explicit asyncio-friendly wrappers.

The Fireweave runtime is a thread-safe sync core. Async servers use
:class:`AsyncFireweaveClient`, which delegates every call to the sync client
via ``asyncio.to_thread`` so the event loop never blocks on adapter I/O.
For OpenFeature, the 0.10 SDK's ``resolve_*_details_async`` defaults already
delegate to our sync resolvers on a worker thread-friendly runtime.

Guarantees:

- No event-loop blocking: every potentially-I/O call is offloaded.
- Deterministic shutdown: ``await client.shutdown()`` flushes exposures and
  closes the adapter exactly once (idempotent), same as the sync client.
- Safe under mixed workloads: the same underlying sync client may be shared
  between threaded and asyncio callers.
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional

from .client import (
    CapabilityResult,
    ExposureResult,
    FireweaveClient,
    FlushResult,
    ReleaseResult,
    SignalResult,
)
from .context import EvaluationContext
from .decision import Decision
from .types import FlagType, JsonValue

__all__ = ["AsyncFireweaveClient"]


class AsyncFireweaveClient:
    """Asyncio facade over a (thread-safe) sync :class:`FireweaveClient`."""

    def __init__(self, sync_client: FireweaveClient) -> None:
        self._sync = sync_client

    @property
    def sync_client(self) -> FireweaveClient:
        return self._sync

    # -- lifecycle -----------------------------------------------------------

    async def initialize(self, *, backend_required: bool = False) -> None:
        await asyncio.to_thread(
            self._sync.initialize, backend_required=backend_required
        )

    async def shutdown(self, timeout_ms: Optional[int] = None) -> None:
        await asyncio.to_thread(self._sync.shutdown, timeout_ms)

    async def __aenter__(self) -> "AsyncFireweaveClient":
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        await self.shutdown()

    # -- flags ---------------------------------------------------------------

    async def get_boolean_value(
        self, flag_key: str, default: bool, context: Optional[EvaluationContext] = None
    ) -> bool:
        return await asyncio.to_thread(
            self._sync.flags.get_boolean_value, flag_key, default, context
        )

    async def get_string_value(
        self, flag_key: str, default: str, context: Optional[EvaluationContext] = None
    ) -> str:
        return await asyncio.to_thread(
            self._sync.flags.get_string_value, flag_key, default, context
        )

    async def get_integer_value(
        self, flag_key: str, default: int, context: Optional[EvaluationContext] = None
    ) -> int:
        return await asyncio.to_thread(
            self._sync.flags.get_integer_value, flag_key, default, context
        )

    async def get_float_value(
        self, flag_key: str, default: float, context: Optional[EvaluationContext] = None
    ) -> float:
        return await asyncio.to_thread(
            self._sync.flags.get_float_value, flag_key, default, context
        )

    async def get_object_value(
        self,
        flag_key: str,
        default: JsonValue,
        context: Optional[EvaluationContext] = None,
    ) -> JsonValue:
        return await asyncio.to_thread(
            self._sync.flags.get_object_value, flag_key, default, context
        )

    async def get_details(
        self,
        flag_key: str,
        flag_type: FlagType,
        default: Any,
        context: Optional[EvaluationContext] = None,
        *,
        include_payload: bool = False,
    ) -> Decision:
        return await asyncio.to_thread(
            lambda: self._sync.flags.get_details(
                flag_key, flag_type, default, context, include_payload=include_payload
            )
        )

    # -- extensions ------------------------------------------------------------

    async def releases_set_context(self, *args: Any, **kwargs: Any) -> ReleaseResult:
        return await asyncio.to_thread(
            lambda: self._sync.releases.set_context(*args, **kwargs)
        )

    async def releases_start(self, *args: Any, **kwargs: Any) -> ReleaseResult:
        return await asyncio.to_thread(lambda: self._sync.releases.start(*args, **kwargs))

    async def releases_complete(self, *args: Any, **kwargs: Any) -> ReleaseResult:
        return await asyncio.to_thread(
            lambda: self._sync.releases.complete(*args, **kwargs)
        )

    async def releases_fail(self, *args: Any, **kwargs: Any) -> ReleaseResult:
        return await asyncio.to_thread(lambda: self._sync.releases.fail(*args, **kwargs))

    async def exposures_record(self, *args: Any, **kwargs: Any) -> ExposureResult:
        return await asyncio.to_thread(
            lambda: self._sync.exposures.record(*args, **kwargs)
        )

    async def exposures_flush(self) -> FlushResult:
        return await asyncio.to_thread(self._sync.exposures.flush)

    async def signals_record_health(self, *args: Any, **kwargs: Any) -> SignalResult:
        return await asyncio.to_thread(
            lambda: self._sync.signals.record_health(*args, **kwargs)
        )

    async def signals_record_error(self, *args: Any, **kwargs: Any) -> SignalResult:
        return await asyncio.to_thread(
            lambda: self._sync.signals.record_error(*args, **kwargs)
        )

    async def signals_record_metric(self, *args: Any, **kwargs: Any) -> SignalResult:
        return await asyncio.to_thread(
            lambda: self._sync.signals.record_metric(*args, **kwargs)
        )

    async def signals_record_outcome(self, *args: Any, **kwargs: Any) -> SignalResult:
        return await asyncio.to_thread(
            lambda: self._sync.signals.record_outcome(*args, **kwargs)
        )

    async def capabilities_get(self) -> list:
        return await asyncio.to_thread(self._sync.capabilities.get)

    async def capabilities_invoke(self, capability: str, **args: Any) -> CapabilityResult:
        return await asyncio.to_thread(
            lambda: self._sync.capabilities.invoke(capability, **args)
        )
