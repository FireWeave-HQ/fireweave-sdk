"""FireweaveLocalAdapter — the DEV substrate for a scaffolded harness.

Counterpart to :class:`~fireweave.infrastructure.adapters.remote.FireweaveRemoteAdapter`:
prod evaluates control points against fw-server; dev evaluates them here,
in-process, with no network and no credentials. Because it satisfies the same
`BackendAdapter` port, the dev branch of a harness runs through the same
`FireweaveRuntime` as prod — inheriting identical lifecycle gating and
context canonicalization.

Resolution policy is deliberately minimal:

- a key present in ``dev_flags`` resolves to its mapped value with reason
  ``STATIC`` — the only supported way to turn a control point ON (or force it
  OFF) on a laptop;
- every other key MISSES (``FlagResolution(matched=False)``), which the
  runtime turns into the caller's own default with reason ``DEFAULT`` — not
  an error (spec/modes.md "Behaviour per mode": local's unknown-key row is
  deliberately ``default``/``DEFAULT``, unlike remote's
  ``default``/``ERROR``/``FlagNotFound``).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Mapping, Optional

from ...domain.context import EvaluationContext
from ...domain.target import TargetKind
from ...application.ports import FlagResolution, RegisterTargetOptions, RegisterTargetResult

__all__ = ["FireweaveLocalAdapter", "LocalRegisteredTarget"]


@dataclass(frozen=True)
class LocalRegisteredTarget:
    """A target recorded by :meth:`FireweaveLocalAdapter.register_target`."""

    targeting_key: str
    kind: TargetKind
    properties: Dict[str, object] = field(default_factory=dict)
    environment: Optional[str] = None


class FireweaveLocalAdapter:
    """In-process boolean overrides for local development."""

    # Not "inmemory" — that name belongs to InMemoryAdapter, the
    # tests/fixtures adapter. This is a distinct dev substrate.
    backend_name = "other"

    def __init__(
        self,
        dev_flags: Optional[Mapping[str, bool]] = None,
        *,
        log: Optional[Callable[[str], None]] = None,
    ) -> None:
        self._dev_flags: Dict[str, bool] = dict(dev_flags or {})
        # Sink for the local registerTarget trace. Defaults to `print`.
        # Injectable so tests assert the call without capturing stdout, and
        # so a host that owns its logging can route it.
        self._log: Callable[[str], None] = log or (lambda message: print(message))
        self._targets: Dict[str, LocalRegisteredTarget] = {}
        self._closed = False

    def initialize(self) -> None:
        self._closed = False

    def resolve(self, flag_key: str, context: EvaluationContext) -> FlagResolution:
        """A ``dev_flags`` hit reports ``enabled=True`` alongside reason
        ``STATIC``. Reporting ``enabled=False`` for an override of ``False``
        would make the runtime label the decision ``DISABLED`` — "the
        control point exists but is switched off upstream" — not what a
        local override expresses.

        A miss returns ``matched=False`` — the strict, typed seam
        `FireweaveRuntime._decision_from_resolution` reads to return the
        caller's default with reason ``DEFAULT`` instead of falling through
        to the generic FlagNotFound/ERROR path (spec/modes.md). This
        adapter never RAISES on a miss — raising here would be
        indistinguishable, from the runtime's perspective, from a genuine
        backend failure, and would produce the wrong (ERROR) reason.
        """
        del context  # unused; kept for BackendAdapter signature parity
        if flag_key not in self._dev_flags:
            return FlagResolution(value=None, matched=False)
        override = self._dev_flags[flag_key]
        return FlagResolution(
            value=override,
            variant="on" if override else "off",
            enabled=True,
            matched=True,
            fireweave_reason="STATIC",
        )

    def register_target(
        self,
        targeting_key: str,
        options: Optional[RegisterTargetOptions] = None,
    ) -> RegisterTargetResult:
        """Records the target in-process and traces it, rather than
        reporting ``UnsupportedCapability`` (spec/modes.md "registerTarget in
        local mode").

        The failure being guarded against is a developer believing their
        targeting works because nothing objected. A recorded target plus an
        explicit ``[fireweave:local]`` line preserves that guarantee:
        nothing is silent, and local dev can exercise targeting rules
        offline instead of only in production.

        The trace names the mode, so a line appearing in a production log is
        itself the signal that something booted in local mode by mistake.

        No network call is made and nothing reaches fw-server.
        """
        opts = options or RegisterTargetOptions()
        kind: TargetKind = opts.kind or "user"
        properties: Dict[str, object] = dict(opts.properties or {})
        target = LocalRegisteredTarget(
            targeting_key=targeting_key,
            kind=kind,
            properties=properties,
            environment=opts.environment,
        )
        self._targets[targeting_key] = target
        self._log(
            f"[fireweave:local] registerTarget {kind} {targeting_key} "
            f"{json.dumps(properties, sort_keys=True)} — recorded in-process, "
            "NOT sent to fw-server"
        )
        return RegisterTargetResult(ok=True)

    def get_registered_targets(self) -> List[LocalRegisteredTarget]:
        """Targets recorded this process, for assertions and dev inspection."""
        return list(self._targets.values())

    def shutdown(self, timeout_ms: int) -> None:
        del timeout_ms
        self._closed = True

    def is_closed(self) -> bool:
        return self._closed
