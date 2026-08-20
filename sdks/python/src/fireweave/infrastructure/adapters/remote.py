"""Fireweave remote backend adapter — default production path.

HTTP client for fw-server ``POST /v1/flags/evaluate`` and
``POST /v1/targets/register``. Auth: ``Authorization: Bearer <api_key>``.
Speaks only the vendor-neutral Fireweave remote protocol — no vendor SDK,
key, or host ever enters the application process; which backend fw-server
forwards to is fw-server's concern (spec/remote-protocol.md).
"""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, Optional
from urllib.parse import urlparse

from ...domain.context import EvaluationContext
from ...domain.errors import (
    AlreadyClosedError,
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
    TargetingKeyMissingError,
    TimeoutError_,
)
from ...application.ports import FlagResolution, RegisterTargetOptions, RegisterTargetResult
from ..hosts import assert_host_allowed

__all__ = ["FireweaveRemoteAdapter"]

_EVALUATE_PATH = "/v1/flags/evaluate"
_REGISTER_TARGET_PATH = "/v1/targets/register"


def _default_allowed_hosts_for(api_url: str) -> Optional[tuple]:
    """Adapter-level default when the caller supplies no `allowed_hosts`:
    the URL's own hostname plus loopback — NOT the canonical
    `infrastructure/hosts.DEFAULT_ALLOWED_HOSTS` list. `application/mode.py`
    (the sanctioned entry point) already enforces the stricter canonical
    default before this adapter is ever constructed; this fallback only
    matters for direct adapter construction that bypasses `init_fireweave`.
    """
    try:
        hostname = urlparse(api_url).hostname
    except ValueError:
        hostname = None
    if not hostname:
        return None
    return (hostname, "localhost", "127.0.0.1", "::1")


@dataclass
class FireweaveRemoteAdapter:
    """Vendor-neutral remote adapter speaking the Fireweave wire protocol."""

    api_url: Optional[str] = None
    api_key: Optional[str] = None
    allowed_hosts: Optional[tuple] = None
    request_timeout_ms: int = 3000
    # Test injection: callable(url, data, headers, timeout) -> (status, body_dict)
    transport: Any = None

    backend_name: str = "fireweave"
    _ready: bool = field(default=False, init=False, repr=False)
    _closed: bool = field(default=False, init=False, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False)

    def initialize(self) -> None:
        if self._closed:
            raise AlreadyClosedError()
        api_url = (self.api_url or "").rstrip("/")
        api_key = self.api_key or ""
        if not api_url or not api_key:
            raise ConfigurationError("invalid configuration", init_fatal=True)
        allow = self.allowed_hosts
        if allow is None:
            allow = _default_allowed_hosts_for(api_url)
        assert_host_allowed(api_url, allow)
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
            raise TargetingKeyMissingError()

        attributes: Dict[str, Any] = {}
        groups = None
        group_properties = None
        for k, v in (context.attributes or {}).items():
            if k in ("groups", "fireweave.groups") and isinstance(v, dict):
                groups = v
                continue
            if k in ("groupProperties", "fireweave.groupProperties") and isinstance(v, dict):
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
        quota_limited = bool(data.get("quotaLimited"))
        if item is None or item.get("found") is False:
            # key unknown to the backend -> ERROR/FlagNotFound
            # (spec/control-points.md return-discipline table) — deliberately
            # NOT `matched=False` (that path means the local-mode "no
            # decision, use the caller's default" seam, which does not apply
            # to remote's "unknown key" row).
            raise FlagNotFoundError(quota_limited=quota_limited)

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
        )

    def register_target(
        self,
        targeting_key: str,
        options: Optional[RegisterTargetOptions] = None,
    ) -> RegisterTargetResult:
        """Register a user or device for durable property targeting.

        Never raises for transport failures: registration sits in login
        paths, and an analytics call must not break sign-in. Retried ONCE
        when the error taxonomy marks the failure retryable; a rejected
        payload or bad key is not retried, since it would be rejected
        identically.
        """
        if self._closed:
            return RegisterTargetResult(ok=False, error=AlreadyClosedError())
        if not self._ready:
            return RegisterTargetResult(ok=False, error=NotReadyError())
        if targeting_key == "":
            return RegisterTargetResult(ok=False, error=TargetingKeyMissingError())

        opts = options or RegisterTargetOptions()
        body: Dict[str, Any] = {"targetingKey": targeting_key}
        if opts.kind is not None:
            body["kind"] = opts.kind
        if opts.environment is not None:
            body["environment"] = opts.environment
        if opts.properties:
            body["properties"] = dict(opts.properties)

        last_error: Optional[FireweaveError] = None
        for _attempt in range(2):
            try:
                self._request(_REGISTER_TARGET_PATH, body)
                return RegisterTargetResult(ok=True)
            except FireweaveError as err:
                last_error = err
                if not err.retryable:
                    break
            except Exception:
                last_error = BackendUnavailableError()
                break
        return RegisterTargetResult(ok=False, error=last_error)

    def shutdown(self, timeout_ms: int) -> None:
        del timeout_ms
        if self._closed:
            return
        self._closed = True
        self._ready = False

    def is_closed(self) -> bool:
        return self._closed

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
        if status >= 400:
            raise BackendUnavailableError()
        if not isinstance(parsed, dict):
            raise MalformedResponseError()
        return parsed
