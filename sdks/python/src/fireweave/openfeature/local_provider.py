"""``make_fireweave_local_provider()`` — OpenFeature provider for the DEV branch.

Wires :class:`FireweaveLocalAdapter` through the ordinary
:class:`FireweaveRuntime` + :class:`FireweaveProvider` stack, then applies one
narrow rewrite on the way out: ``FLAG_NOT_FOUND`` becomes a clean ``DEFAULT``
resolution. Real defects (``PROVIDER_NOT_READY``, ``INVALID_CONTEXT``,
``TYPE_MISMATCH``, ``PROVIDER_FATAL``) pass through untouched.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Callable, List, Mapping, Optional, Sequence, Union

from openfeature.evaluation_context import EvaluationContext as OFContext
from openfeature.exception import ErrorCode
from openfeature.flag_evaluation import FlagResolutionDetails, Reason as OFReason
from openfeature.provider import AbstractProvider, Metadata

from ..adapters.local import FireweaveLocalAdapter
from ..runtime import FireweaveRuntime
from .provider import FireweaveProvider

__all__ = [
    "FwLocalCapture",
    "get_fw_local_captures",
    "reset_fw_local_captures",
    "make_fireweave_local_provider",
]


@dataclass(frozen=True)
class FwLocalCapture:
    flag_key: str
    type: str  # boolean | string | integer | float | object | number
    value: Any
    reason: str
    ts: float


_captures: List[FwLocalCapture] = []


def get_fw_local_captures() -> Sequence[FwLocalCapture]:
    """Every evaluation observed through a local provider in this process."""
    return tuple(_captures)


def reset_fw_local_captures() -> None:
    """Clear the capture buffer (call between tests)."""
    global _captures
    _captures = []


class _FireweaveLocalProvider(AbstractProvider):
    def __init__(
        self,
        *,
        dev_flags: Optional[Mapping[str, bool]] = None,
        echo: bool = False,
        now: Optional[Callable[[], float]] = None,
    ) -> None:
        adapter = FireweaveLocalAdapter(dev_flags=dev_flags)
        # Eager readiness: a laptop has nothing to connect to.
        self._inner = FireweaveProvider(FireweaveRuntime(adapter))
        self._echo = echo
        self._now = now or time.time

    def get_metadata(self) -> Metadata:
        return Metadata(name="fireweave-local")

    def initialize(self, evaluation_context: OFContext) -> None:
        self._inner.initialize(evaluation_context)

    def shutdown(self) -> None:
        self._inner.shutdown()

    def resolve_boolean_details(
        self,
        flag_key: str,
        default_value: bool,
        evaluation_context: Optional[OFContext] = None,
    ) -> FlagResolutionDetails[bool]:
        return self._finish(
            "boolean",
            flag_key,
            default_value,
            self._inner.resolve_boolean_details(
                flag_key, default_value, evaluation_context
            ),
        )

    def resolve_string_details(
        self,
        flag_key: str,
        default_value: str,
        evaluation_context: Optional[OFContext] = None,
    ) -> FlagResolutionDetails[str]:
        return self._finish(
            "string",
            flag_key,
            default_value,
            self._inner.resolve_string_details(
                flag_key, default_value, evaluation_context
            ),
        )

    def resolve_integer_details(
        self,
        flag_key: str,
        default_value: int,
        evaluation_context: Optional[OFContext] = None,
    ) -> FlagResolutionDetails[int]:
        return self._finish(
            "integer",
            flag_key,
            default_value,
            self._inner.resolve_integer_details(
                flag_key, default_value, evaluation_context
            ),
        )

    def resolve_float_details(
        self,
        flag_key: str,
        default_value: float,
        evaluation_context: Optional[OFContext] = None,
    ) -> FlagResolutionDetails[float]:
        return self._finish(
            "float",
            flag_key,
            default_value,
            self._inner.resolve_float_details(
                flag_key, default_value, evaluation_context
            ),
        )

    def resolve_object_details(
        self,
        flag_key: str,
        default_value: Union[Sequence[Any], Mapping[str, Any]],
        evaluation_context: Optional[OFContext] = None,
    ) -> FlagResolutionDetails[Union[Sequence[Any], Mapping[str, Any]]]:
        return self._finish(
            "object",
            flag_key,
            default_value,
            self._inner.resolve_object_details(
                flag_key, default_value, evaluation_context
            ),
        )

    def _finish(
        self,
        type_: str,
        flag_key: str,
        default_value: Any,
        details: FlagResolutionDetails[Any],
    ) -> FlagResolutionDetails[Any]:
        if details.error_code == ErrorCode.FLAG_NOT_FOUND:
            resolved = FlagResolutionDetails(
                value=default_value,
                variant="default",
                reason=OFReason.DEFAULT,
            )
        else:
            resolved = details
        self._record(
            type_,
            flag_key,
            resolved.value,
            str(resolved.reason) if resolved.reason is not None else "UNKNOWN",
        )
        return resolved

    def _record(self, type_: str, flag_key: str, value: Any, reason: str) -> None:
        _captures.append(
            FwLocalCapture(
                flag_key=flag_key,
                type=type_,
                value=value,
                reason=reason,
                ts=self._now(),
            )
        )
        if self._echo:
            print(
                f"[fw-local] {type_} {flag_key} = {json.dumps(value, default=str)} ({reason})"
            )


def make_fireweave_local_provider(
    *,
    dev_flags: Optional[Mapping[str, bool]] = None,
    echo: bool = False,
    now: Optional[Callable[[], float]] = None,
) -> AbstractProvider:
    """Build the dev-branch OpenFeature provider.

    Example::

        from fireweave.openfeature import make_fireweave_local_provider

        provider = make_fireweave_local_provider(
            echo=True,
            dev_flags={"my-feature": True},
        )
    """
    return _FireweaveLocalProvider(dev_flags=dev_flags, echo=echo, now=now)
