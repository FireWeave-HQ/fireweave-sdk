"""PostHog backend adapter (requires the ``fireweave[posthog]`` extra).

Wraps ``posthog==7.31.0`` per ADR-0002:

- **Snapshot evaluation**: uses ``Client.evaluate_flags()`` — one snapshot per
  evaluation context; per-flag reads never trigger extra network calls or
  vendor-side ``$feature_flag_called`` events (Fireweave owns exposures).
- **Modes**: remote (``phc_`` project key -> /flags?v=2) or local evaluation
  (``phs_`` secret key / ``phx_`` personal key -> definitions poll).
- **Owned vs injected client**: pass ``client=`` to inject a preconfigured
  ``posthog.Posthog`` (the adapter will NOT shut it down), or pass config and
  the adapter owns the client lifecycle.
- **No vendor types in the public API**: this module returns only
  :class:`~fireweave.adapters.base.FlagResolution` and Fireweave errors.
- **Transport injection**: ``transport=`` overrides the snapshot fetcher for
  fault testing; transport exceptions are mapped to the canonical taxonomy by
  :func:`map_transport_error`.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Protocol

from ..config import FireweaveConfig
from ..context import EvaluationContext
from ..errors import (
    AuthenticationError,
    AuthorizationError,
    BackendUnavailableError,
    ConfigurationError,
    FireweaveError,
    FlagNotFoundError,
    MalformedResponseError,
    NetworkError,
    NotReadyError,
    RateLimitedError,
    TimeoutError_,
)
from .base import FlagResolution

__all__ = [
    "PostHogAdapter",
    "SnapshotTransport",
    "SnapshotData",
    "VendorFlagRecord",
    "map_transport_error",
]


@dataclass(frozen=True)
class VendorFlagRecord:
    """Vendor-neutral copy of one evaluated flag from a snapshot."""

    key: str
    enabled: bool
    variant: Optional[str] = None
    payload: Optional[Any] = None
    flag_id: Optional[int] = None
    version: Optional[int] = None
    reason: Optional[str] = None
    locally_evaluated: bool = False


@dataclass(frozen=True)
class SnapshotData:
    """Result of one snapshot fetch."""

    flags: Dict[str, VendorFlagRecord] = field(default_factory=dict)
    quota_limited: bool = False
    errors_while_computing: bool = False
    from_cache: bool = False


class SnapshotTransport(Protocol):
    """Fetches a flag snapshot for one identity; raises on transport failure."""

    def fetch(
        self,
        distinct_id: str,
        groups: Dict[str, str],
        person_properties: Dict[str, Any],
        group_properties: Dict[str, Dict[str, Any]],
    ) -> SnapshotData: ...


def map_transport_error(exc: Exception) -> FireweaveError:
    """Map transport exceptions to the canonical 15-kind taxonomy.

    The original exception is preserved on ``__cause__``; messages are the
    canonical safe defaults (no URLs, keys, or payload echoes).
    """
    mapped: FireweaveError
    status = _http_status(exc)
    if status is not None:
        if status == 401:
            mapped = AuthenticationError()
        elif status == 403:
            mapped = AuthorizationError()
        elif status == 429:
            mapped = RateLimitedError()
        elif status >= 500:
            mapped = BackendUnavailableError()
        else:
            mapped = BackendUnavailableError()
    elif isinstance(exc, (json.JSONDecodeError,)):
        mapped = MalformedResponseError()
    else:
        mapped = _map_requests_error(exc)
    mapped.__cause__ = exc
    return mapped


def _http_status(exc: Exception) -> Optional[int]:
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    if isinstance(status, int):
        return status
    status = getattr(exc, "status_code", None) or getattr(exc, "status", None)
    return status if isinstance(status, int) else None


def _map_requests_error(exc: Exception) -> FireweaveError:
    try:
        import requests.exceptions as rex
    except ImportError:  # pragma: no cover - requests ships with posthog
        return NetworkError()
    if isinstance(exc, rex.Timeout):
        return TimeoutError_()
    if isinstance(exc, rex.ConnectionError):
        return NetworkError()
    if isinstance(exc, rex.HTTPError):
        return BackendUnavailableError()
    if isinstance(exc, rex.RequestException):
        return NetworkError()
    if isinstance(exc, ValueError):
        return MalformedResponseError()
    return NetworkError()


class _ClientSnapshotTransport:
    """Default transport: ``posthog.Posthog.evaluate_flags`` snapshots.

    Reads the snapshot's internal records directly (no ``is_enabled`` /
    ``get_flag`` calls) so no vendor ``$feature_flag_called`` events fire —
    exposure telemetry is Fireweave-owned and deduped in the client.
    """

    def __init__(self, client: Any, *, only_evaluate_locally: bool) -> None:
        self._client = client
        self._only_locally = only_evaluate_locally

    def fetch(
        self,
        distinct_id: str,
        groups: Dict[str, str],
        person_properties: Dict[str, Any],
        group_properties: Dict[str, Dict[str, Any]],
    ) -> SnapshotData:
        snapshot = self._client.evaluate_flags(
            distinct_id,
            groups=groups or None,
            person_properties=person_properties or None,
            group_properties=group_properties or None,
            only_evaluate_locally=self._only_locally,
        )
        records: Dict[str, VendorFlagRecord] = {}
        for key, rec in getattr(snapshot, "_flags", {}).items():
            records[key] = VendorFlagRecord(
                key=key,
                enabled=bool(rec.enabled),
                variant=rec.variant,
                payload=_parse_payload(rec.payload),
                flag_id=rec.id,
                version=rec.version,
                reason=rec.reason,
                locally_evaluated=bool(rec.locally_evaluated),
            )
        return SnapshotData(
            flags=records,
            quota_limited=bool(getattr(snapshot, "_quota_limited", False)),
            errors_while_computing=bool(
                getattr(snapshot, "_errors_while_computing", False)
            ),
        )


def _parse_payload(payload: Any) -> Any:
    """PostHog payloads may arrive JSON-encoded; decode strings best-effort."""
    if isinstance(payload, str):
        try:
            return json.loads(payload)
        except (ValueError, TypeError):
            return payload
    return payload


# PostHog condition-match reason strings that indicate a targeting match.
_MATCH_REASONS = frozenset({"condition_match", "matched_condition", "super_condition_value"})


class PostHogAdapter:
    """BackendAdapter over PostHog remote (`phc_`) or local-eval (`phs_`/`phx_`)."""

    def __init__(
        self,
        *,
        client: Optional[Any] = None,
        config: Optional[FireweaveConfig] = None,
        transport: Optional[SnapshotTransport] = None,
    ) -> None:
        if client is None and config is None and transport is None:
            raise ConfigurationError(
                "PostHogAdapter requires a client, a config, or a transport",
                init_fatal=True,
            )
        self._config = config or FireweaveConfig()
        self._injected_client = client
        self._client: Optional[Any] = client
        self._owns_client = client is None and transport is None
        self._transport = transport
        self._initialized = False

    # -- lifecycle -----------------------------------------------------------

    def initialize(self) -> None:
        if self._transport is not None:
            self._initialized = True
            return
        if self._client is None:
            self._config.validate(backend_required=True)
            self._client = self._build_client()
        self._transport = _ClientSnapshotTransport(
            self._client,
            only_evaluate_locally=self._config.only_evaluate_locally,
        )
        self._initialized = True

    def _build_client(self) -> Any:
        try:
            from posthog import Posthog
        except ImportError as exc:
            raise ConfigurationError(
                "posthog extra not installed (pip install 'fireweave[posthog]')",
                init_fatal=True,
            ) from exc
        cfg = self._config
        kwargs: Dict[str, Any] = {
            "host": cfg.host,
            "feature_flags_request_timeout_seconds": (
                cfg.feature_flags_request_timeout_ms / 1000.0
            ),
            "enable_local_evaluation": cfg.local_evaluation,
            "sync_mode": False,
        }
        if cfg.personal_api_key:
            kwargs["personal_api_key"] = cfg.personal_api_key  # phx_
        if cfg.secret_key:
            kwargs["secret_key"] = cfg.secret_key  # phs_
        return Posthog(cfg.project_api_key, **kwargs)

    def shutdown(self, timeout_ms: int) -> None:
        self._initialized = False
        self._transport = None
        client, self._client = self._client, None
        if client is not None and self._owns_client:
            for method in ("flush", "shutdown"):
                fn = getattr(client, method, None)
                if callable(fn):
                    try:
                        fn()
                    except Exception:
                        pass

    # -- resolution ------------------------------------------------------------

    def resolve(self, flag_key: str, context: EvaluationContext) -> FlagResolution:
        if not self._initialized or self._transport is None:
            raise NotReadyError()

        distinct_id = context.targeting_key or ""
        plain = context.plain_attributes
        groups = context.groups
        group_properties = context.group_properties
        person_properties = {
            k: v
            for k, v in plain.items()
            if k not in ("groups", "groupProperties")
            and not k.startswith("fireweave.")
        }

        try:
            snapshot = self._transport.fetch(
                distinct_id, groups, person_properties, group_properties
            )
        except FireweaveError:
            raise
        except Exception as exc:
            raise map_transport_error(exc) from exc

        record = snapshot.flags.get(flag_key)
        if record is None:
            raise FlagNotFoundError(quota_limited=snapshot.quota_limited)

        # Value model: structured payload wins; else variant string; else the
        # boolean gate. Type conformance is enforced by the runtime.
        if record.payload is not None:
            value: Any = record.payload
        elif record.variant is not None:
            value = record.variant
        else:
            value = record.enabled

        return FlagResolution(
            value=value,
            variant=record.variant,
            enabled=record.enabled,
            matched=True,
            version=record.version,
            vendor_flag_id=record.flag_id,
            reason_code=record.reason,
            payload=record.payload,
            from_cache=snapshot.from_cache,
            quota_limited=snapshot.quota_limited,
        )

    # -- exposures ---------------------------------------------------------------

    def send_exposures(self, events: list) -> None:
        """Emit deduped Fireweave exposure events via the vendor client."""
        client = self._client
        if client is None:
            return
        capture = getattr(client, "capture", None)
        if not callable(capture):
            return
        for event in events:
            try:
                capture(
                    distinct_id=event.get("targetingKey"),
                    event="$feature_flag_called",
                    properties={
                        "$feature_flag": event.get("flagKey"),
                        "$feature_flag_response": event.get("value"),
                        "$feature_flag_variant": event.get("variant"),
                        "fireweave.rolloutId": event.get("rolloutId"),
                    },
                )
            except Exception:
                # Telemetry loss must never affect callers.
                pass
