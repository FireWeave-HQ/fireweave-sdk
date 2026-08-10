"""Local development adapter — the DEV substrate for a scaffolded harness.

Counterpart to :class:`FireweaveRemoteAdapter`: prod evaluates control points
against fw-server; dev evaluates them here, in-process, with no network and no
credentials. Because it satisfies the same :class:`BackendAdapter` port, the
dev branch of a harness runs through the same :class:`FireweaveRuntime` as
prod — inheriting identical lifecycle gating and context canonicalization.
"""

from __future__ import annotations

from typing import Dict, Mapping, Optional

from ..context import EvaluationContext
from ..errors import FlagNotFoundError
from .base import FlagResolution

__all__ = ["FireweaveLocalAdapter"]


class FireweaveLocalAdapter:
    """In-process boolean overrides for local development.

    Resolution policy:

    - a key present in ``dev_flags`` resolves to its mapped value with reason
      ``STATIC``;
    - every other key raises :class:`FlagNotFoundError`, which the runtime
      turns into an ERROR decision. :func:`make_fireweave_local_provider`
      rewrites that single outcome to a clean DEFAULT for the OpenFeature path.
    """

    backend_name = "other"

    def __init__(self, dev_flags: Optional[Mapping[str, bool]] = None) -> None:
        self._dev_flags: Dict[str, bool] = dict(dev_flags or {})
        self._closed = False

    def initialize(self) -> None:
        self._closed = False

    def resolve(self, flag_key: str, context: EvaluationContext) -> FlagResolution:
        # A ``dev_flags`` hit reports ``enabled=True`` alongside reason STATIC.
        # Reporting ``enabled=False`` for an override of ``False`` would make
        # the runtime label the decision DISABLED — "switched off upstream" —
        # not what a local override expresses.
        #
        # Values are always boolean, so reading an overridden key as a string
        # or number yields TYPE_MISMATCH rather than silently defaulting.
        del context  # unused; kept for BackendAdapter signature parity
        if flag_key not in self._dev_flags:
            raise FlagNotFoundError()
        override = self._dev_flags[flag_key]
        return FlagResolution(
            value=override,
            variant="on" if override else "off",
            enabled=True,
            matched=True,
            fireweave_reason="STATIC",
        )

    def shutdown(self, timeout_ms: int) -> None:
        del timeout_ms
        self._closed = True

    def runtime_features(self) -> Dict[str, bool]:
        return {
            "remoteEvaluation": False,
            "localEvaluation": True,
            "localOnly": True,
            # No exposure sink exists locally; claiming otherwise would make
            # capabilities.get() advertise emission that silently goes nowhere.
            "exposureEmission": False,
            "sideEffectFreeReads": True,
            "groupAnalytics": False,
        }
