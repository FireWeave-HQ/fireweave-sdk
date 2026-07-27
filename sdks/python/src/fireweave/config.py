"""Fireweave client/runtime configuration and validation.

Configuration failures are :class:`fireweave.errors.ConfigurationError` with
``init_fatal=True`` when raised during initialization (mapping to the
OpenFeature ``PROVIDER_FATAL`` code per contracts/errors.json).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Tuple
from urllib.parse import urlparse

from .context import ContextLimits
from .errors import ConfigurationError
from .types import SHUTDOWN_TIMEOUT_MS_DEFAULT

__all__ = ["FireweaveConfig"]

_DEFAULT_RESERVED_KEYS: Tuple[str, ...] = ("targetingKey", "kind")


@dataclass(frozen=True)
class FireweaveConfig:
    """Immutable runtime configuration.

    Only PostHog-backed deployments need ``project_api_key``/``host``; the
    in-memory adapter runs with an empty config. ``allowed_hosts`` is an
    egress allowlist (SSRF guard): when set, the backend host must match one
    of the entries exactly (hostname comparison).
    """

    project_api_key: Optional[str] = None
    host: Optional[str] = None
    personal_api_key: Optional[str] = None
    secret_key: Optional[str] = None
    local_evaluation: bool = False
    only_evaluate_locally: bool = False
    require_targeting_key: bool = False
    allow_anonymous: bool = True
    allowed_hosts: Optional[Tuple[str, ...]] = None
    reserved_attribute_keys: Tuple[str, ...] = _DEFAULT_RESERVED_KEYS
    limits: ContextLimits = field(default_factory=ContextLimits)
    feature_flags_request_timeout_ms: int = 3000
    shutdown_timeout_ms: int = SHUTDOWN_TIMEOUT_MS_DEFAULT

    def validate(self, *, backend_required: bool = False) -> None:
        """Validate config; raise ``ConfigurationError(init_fatal=True)``.

        Error messages never echo credential values.
        """
        if backend_required:
            if not self.project_api_key or not self.project_api_key.strip():
                raise ConfigurationError(
                    "invalid configuration", init_fatal=True
                )
        if self.host is not None:
            parsed = urlparse(self.host)
            if parsed.scheme not in ("http", "https") or not parsed.hostname:
                raise ConfigurationError("invalid configuration", init_fatal=True)
            if self.allowed_hosts is not None and parsed.hostname not in self.allowed_hosts:
                # SSRF allowlist breach: never echo the key or full URL.
                raise ConfigurationError("invalid configuration", init_fatal=True)
        if self.local_evaluation and not (
            self.personal_api_key or self.secret_key
        ) and backend_required:
            raise ConfigurationError("invalid configuration", init_fatal=True)
        if self.feature_flags_request_timeout_ms <= 0 or self.shutdown_timeout_ms <= 0:
            raise ConfigurationError("invalid configuration", init_fatal=True)
