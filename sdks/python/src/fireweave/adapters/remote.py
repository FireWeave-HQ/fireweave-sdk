"""Fireweave remote backend adapter (ADR-0005) — default production path.

HTTP client for fw-server ``POST /v1/flags/evaluate`` and ``POST /v1/capture``.
Auth: ``Authorization: Bearer <FW_PROJECT_API_KEY>``. No PostHog dependency.
"""

from __future__ import annotations

import json
import os
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from ..config import FireweaveConfig
from ..context import EvaluationContext
from ..errors import (
    AlreadyClosedError,
    AuthenticationError,
    AuthorizationError,
    BackendUnavailableError,
    ConfigurationError,
    InvalidContextError,
    MalformedResponseError,
    NetworkError,
    NotReadyError,
    RateLimitedError,
    TimeoutError_,
)
from .base import FlagResolution

__all__ = ["FireweaveRemoteAdapter"]

_EVALUATE_PATH = "/v1/flags/evaluate"
_CAPTURE_PATH = "/v1/capture"


@dataclass
class FireweaveRemoteAdapter:
    """Vendor-neutral remote adapter speaking the Fireweave wire protocol."""

    api_url: Optional[str] = None
    api_key: Optional[str] = None
    allowed_hosts: Optional[tuple[str, ...]] = None
    request_timeout_ms: int = 3000
    shutdown_timeout_ms: int = 10000
    # Test injection: callable(url, data, headers, timeout) -> (status, body_dict)
    transport: Any = None

    backend_name: str = "fireweave"
    _ready: bool = field(default=False, init=False, repr=False)
    _closed: bool = field(default=False, init=False, repr=False)
    _pending: List[Dict[str, Any]] = field(default_factory=list, init=False, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False)

    def initialize(self, config: Optional[FireweaveConfig] = None) -> None:
        if self._closed:
            raise AlreadyClosedError()
        api_url = (self.api_url or os.environ.get("FW_API_URL") or "").rstrip("/")
        api_key = self.api_key or os.environ.get("FW_PROJECT_API_KEY") or ""
        if config is not None:
            if not api_url and config.host:
                api_url = config.host.rstrip("/")
            if not api_key and config.project_api_key:
                api_key = config.project_api_key
            if config.feature_flags_request_timeout_ms:
                self.request_timeout_ms = config.feature_flags_request_timeout_ms
        if not api_url or not api_key:
            raise ConfigurationError("invalid configuration", init_fatal=True)
        parsed = urlparse(api_url)
        hostname = (parsed.hostname or "").lower()
        if parsed.scheme not in ("http", "https") or not hostname:
            raise ConfigurationError("invalid configuration", init_fatal=True)
        if parsed.scheme == "http" and hostname not in ("localhost", "127.0.0.1", "::1"):
            raise ConfigurationError("invalid configuration", init_fatal=True)
        allow = self.allowed_hosts
        if allow is None and config is not None and config.allowed_hosts is not None:
            allow = config.allowed_hosts
        if allow is None:
            allow = (hostname, "localhost", "127.0.0.1", "::1")
        if "*" not in allow and hostname not in {h.lower() for h in allow}:
            raise ConfigurationError("invalid configuration", init_fatal=True)
        self.api_url = api_url
        self.api_key = api_key
        self._ready = True

    def resolve(self, flag_key: str, context: EvaluationContext) -> FlagResolution:
        if self._closed:
            raise AlreadyClosedError()
        if not self._ready:
            raise NotReadyError()
        targeting = context.targeting_key or ""
        if not targeting:
            raise InvalidContextError("targeting key missing")

        attributes: Dict[str, Any] = {}
        groups = None
        group_properties = None
        for k, v in (context.attributes or {}).items():
            if k in ("groups", "fireweave.groups") and isinstance(v, dict):
                groups = v
                continue
            if k in ("groupProperties", "fireweave.groupProperties") and isinstance(
                v, dict
            ):
                group_properties = v
                continue
            if k.startswith("$") or k.startswith("fireweave."):
                continue
            attributes[k] = v

        body: Dict[str, Any] = {"targetingKey": targeting, "flagKeys": [flag_key]}
        if attributes:
            body["attributes"] = attributes
        if groups:
            body["groups"] = groups
        if group_properties:
            body["groupProperties"] = group_properties

        data = self._request(_EVALUATE_PATH, body)
        decisions = data.get("decisions") or []
        item = next((d for d in decisions if d.get("flagKey") == flag_key), None)
        if item is None or item.get("found") is False:
            return FlagResolution(
                value=None,
                matched=False,
                enabled=False,
                quota_limited=bool(data.get("quotaLimited")),
            )
        meta = item.get("flagMetadata") or {}
        return FlagResolution(
            value=item.get("value"),
            variant=item.get("variant"),
            enabled=bool(item.get("enabled", True)),
            matched=True,
            version=meta.get("fireweave.flagVersion"),
            vendor_flag_id=meta.get("fireweave.vendorFlagId"),
            reason_code=meta.get("fireweave.reasonCode"),
            payload=item.get("payload"),
            fireweave_reason=item.get("reason"),
            quota_limited=bool(data.get("quotaLimited") or meta.get("fireweave.quotaLimited")),
        )

    def send_exposures(self, events: list) -> None:
        if self._closed or not self._ready:
            return
        with self._lock:
            for ev in events:
                if isinstance(ev, dict):
                    self._pending.append(
                        {
                            "type": "exposure",
                            "targetingKey": ev.get("targetingKey") or ev.get("targeting_key") or "",
                            "flagKey": ev.get("flagKey") or ev.get("flag_key"),
                            "value": ev.get("value"),
                            "variant": ev.get("variant"),
                        }
                    )

    def deliver_signal(self, signal: Dict[str, Any]) -> None:
        if self._closed or not self._ready:
            return
        with self._lock:
            self._pending.append(
                {
                    "type": "signal",
                    "targetingKey": signal.get("targetingKey")
                    or signal.get("targeting_key")
                    or "fireweave-sdk",
                    "name": signal.get("name"),
                    "flagKey": signal.get("flagKey") or signal.get("flag_key"),
                    "variant": signal.get("variant"),
                    "properties": {
                        "kind": signal.get("kind"),
                        "status": signal.get("status"),
                    },
                }
            )

    def flush(self) -> None:
        if self._closed or not self._ready:
            return
        with self._lock:
            batch = list(self._pending)
            self._pending.clear()
        if not batch:
            return
        try:
            self._request(_CAPTURE_PATH, {"events": batch})
        except Exception:
            with self._lock:
                self._pending[:0] = batch

    def shutdown(self, timeout_ms: int) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self.flush()
        except Exception:
            pass
        self._ready = False

    def runtime_features(self) -> Dict[str, bool]:
        return {
            "remoteEvaluation": True,
            "localEvaluation": False,
            "localOnly": False,
            "exposureEmission": True,
            "sideEffectFreeReads": True,
            "groupAnalytics": True,
        }

    def _request(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        url = f"{self.api_url}{path}"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
        }
        timeout = max(self.request_timeout_ms / 1000.0, 0.001)
        if self.transport is not None:
            status, parsed = self.transport(url, body, headers, timeout)
        else:
            req = urllib.request.Request(
                url,
                data=json.dumps(body).encode("utf-8"),
                headers=headers,
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    status = resp.status
                    raw = resp.read().decode("utf-8")
            except urllib.error.HTTPError as e:
                status = e.code
                raw = e.read().decode("utf-8") if e.fp else ""
            except TimeoutError as e:
                raise TimeoutError_() from e
            except urllib.error.URLError as e:
                reason = getattr(e, "reason", e)
                if isinstance(reason, TimeoutError) or "timed out" in str(reason).lower():
                    raise TimeoutError_() from e
                raise NetworkError() from e
            try:
                parsed = json.loads(raw) if raw else {}
            except json.JSONDecodeError as e:
                raise MalformedResponseError() from e
        if status == 401:
            raise AuthenticationError()
        if status == 403:
            raise AuthorizationError()
        if status == 429:
            raise RateLimitedError()
        if status >= 500:
            raise BackendUnavailableError()
        if status >= 400:
            raise BackendUnavailableError()
        if not isinstance(parsed, dict):
            raise MalformedResponseError()
        return parsed
