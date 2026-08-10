"""Fireweave OpenFeature provider (openfeature-sdk 0.10.x AbstractProvider).

Design notes:

- **Sync core.** The 0.10 SDK's ``resolve_*_details_async`` defaults delegate
  to the sync resolvers; the Fireweave runtime is thread-safe, so both the
  sync and async OpenFeature clients are supported.
- **Status handling.** ``OpenFeatureClient`` short-circuits evaluation when a
  provider reports NOT_READY/FATAL and fabricates a generic error without
  Fireweave metadata. To keep the precise error taxonomy
  (``fireweave.errorKind`` in flagMetadata, AlreadyClosed vs NotReady), the
  provider never throws from ``initialize`` after recording FATAL state —
  instead the runtime degrades every evaluation to a default-valued decision.
  ``initialize`` still raises on configuration failure so the OpenFeature
  PROVIDER_ERROR(FATAL) event fires per spec.
- ``targetingKey`` maps 1:1 to the vendor ``distinct_id``; Fireweave never
  fabricates anonymous identities (identity is caller-owned).
"""

from __future__ import annotations

from typing import Any, List, Mapping, Optional, Sequence, Union

from openfeature.evaluation_context import EvaluationContext as OFContext
from openfeature.exception import ErrorCode
from openfeature.flag_evaluation import FlagResolutionDetails, Reason as OFReason
from openfeature.hook import Hook
from openfeature.provider import AbstractProvider, Metadata

from .._version import __version__
from ..context import EvaluationContext
from ..decision import Decision
from ..runtime import EvaluationOptions, FireweaveRuntime
from ..types import FlagType

__all__ = ["FireweaveProvider"]

_OF_REASONS = {
    "TARGETING_MATCH": OFReason.TARGETING_MATCH,
    "SPLIT": OFReason.SPLIT,
    "DISABLED": OFReason.DISABLED,
    "DEFAULT": OFReason.DEFAULT,
    "STALE": OFReason.STALE,
    "CACHED": OFReason.CACHED,
    "STATIC": OFReason.STATIC,
    "ERROR": OFReason.ERROR,
}


def _to_fireweave_context(of_context: Optional[OFContext]) -> Optional[EvaluationContext]:
    if of_context is None:
        return None
    return EvaluationContext(
        targeting_key=of_context.targeting_key,
        attributes=dict(of_context.attributes or {}),
    )


def _to_resolution_details(decision: Decision) -> FlagResolutionDetails[Any]:
    error_code = ErrorCode(decision.error_code) if decision.error_code else None
    return FlagResolutionDetails(
        value=decision.value,
        variant=decision.variant,
        reason=_OF_REASONS.get(decision.reason, OFReason.UNKNOWN),
        error_code=error_code,
        error_message=decision.error_message,
        flag_metadata=dict(decision.flag_metadata),
    )


class FireweaveProvider(AbstractProvider):
    """OpenFeature provider backed by a :class:`FireweaveRuntime`."""

    def __init__(
        self,
        runtime: FireweaveRuntime,
        *,
        backend_required: bool = False,
        include_payload: bool = False,
    ) -> None:
        self._runtime = runtime
        self._backend_required = backend_required
        self._options = EvaluationOptions(include_payload=include_payload)

    # -- lifecycle -----------------------------------------------------------

    def get_metadata(self) -> Metadata:
        return Metadata(name=f"fireweave/{__version__}")

    def get_provider_hooks(self) -> List[Hook]:
        return []

    def initialize(self, evaluation_context: OFContext) -> None:
        # Bind the OpenFeature API-level context as the Fireweave global layer.
        fw_ctx = _to_fireweave_context(evaluation_context)
        if fw_ctx is not None and (fw_ctx.targeting_key or fw_ctx.attributes):
            self._runtime.set_global_context(fw_ctx)
        self._runtime.initialize(backend_required=self._backend_required)

    def shutdown(self) -> None:
        self._runtime.shutdown()

    @property
    def runtime(self) -> FireweaveRuntime:
        return self._runtime

    # -- resolvers -----------------------------------------------------------

    def _resolve(
        self,
        flag_key: str,
        flag_type: FlagType,
        default_value: Any,
        of_context: Optional[OFContext],
    ) -> FlagResolutionDetails[Any]:
        decision = self._runtime.evaluate(
            flag_key,
            flag_type,
            default_value,
            _to_fireweave_context(of_context),
            self._options,
        )
        return _to_resolution_details(decision)

    def resolve_boolean_details(
        self,
        flag_key: str,
        default_value: bool,
        evaluation_context: Optional[OFContext] = None,
    ) -> FlagResolutionDetails[bool]:
        return self._resolve(flag_key, FlagType.BOOLEAN, default_value, evaluation_context)

    def resolve_string_details(
        self,
        flag_key: str,
        default_value: str,
        evaluation_context: Optional[OFContext] = None,
    ) -> FlagResolutionDetails[str]:
        return self._resolve(flag_key, FlagType.STRING, default_value, evaluation_context)

    def resolve_integer_details(
        self,
        flag_key: str,
        default_value: int,
        evaluation_context: Optional[OFContext] = None,
    ) -> FlagResolutionDetails[int]:
        return self._resolve(flag_key, FlagType.INTEGER, default_value, evaluation_context)

    def resolve_float_details(
        self,
        flag_key: str,
        default_value: float,
        evaluation_context: Optional[OFContext] = None,
    ) -> FlagResolutionDetails[float]:
        return self._resolve(flag_key, FlagType.FLOAT, default_value, evaluation_context)

    def resolve_object_details(
        self,
        flag_key: str,
        default_value: Union[Sequence[Any], Mapping[str, Any]],
        evaluation_context: Optional[OFContext] = None,
    ) -> FlagResolutionDetails[Union[Sequence[Any], Mapping[str, Any]]]:
        return self._resolve(flag_key, FlagType.OBJECT, default_value, evaluation_context)
