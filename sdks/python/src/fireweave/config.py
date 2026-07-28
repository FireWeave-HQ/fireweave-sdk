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

__all__ = ["FireweaveConfig", "DEFAULT_ALLOWED_HOSTS"]

_DEFAULT_RESERVED_KEYS: Tuple[str, ...] = ("targetingKey", "kind")

# Canonical default host allowlist (security review H-1/L-6): identical across
# all four languages — the five PostHog hosts plus loopback. Any other backend
# host requires an explicit ``allowed_hosts`` opt-in.
DEFAULT_ALLOWED_HOSTS: Tuple[str, ...] = (
    "app.posthog.com",
    "us.posthog.com",
    "eu.posthog.com",
    "us.i.posthog.com",
    "eu.i.posthog.com",
    "localhost",
    "127.0.0.1",
    "::1",
)

_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


@dataclass(frozen=True)
class FireweaveConfig:
    """Immutable runtime configuration.

    Only PostHog-backed deployments need ``project_api_key``/``host``; the
    in-memory adapter runs with an empty config. ``allowed_hosts`` is an
    egress allowlist (SSRF guard) and is ON BY DEFAULT: when ``None``, the
    canonical :data:`DEFAULT_ALLOWED_HOSTS` list applies (PostHog hosts +
    loopback). Self-hosted deployments must opt in explicitly by listing
    their host (hostname comparison, case-insensitive; a literal ``"*"``
    entry disables host pinning). ``https`` is required for non-loopback
    hosts; plain ``http`` is permitted on loopback only.
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
            hostname = (parsed.hostname or "").lower()
            if parsed.scheme not in ("http", "https") or not hostname:
                raise ConfigurationError("invalid configuration", init_fatal=True)
            if parsed.scheme == "http" and hostname not in _LOOPBACK_HOSTS:
                # Plain http only on loopback (security review L-3).
                raise ConfigurationError("invalid configuration", init_fatal=True)
            allowed = (
                self.allowed_hosts
                if self.allowed_hosts is not None
                else DEFAULT_ALLOWED_HOSTS
            )
            allowed_lower = {h.lower() for h in allowed}
            if "*" not in allowed_lower and hostname not in allowed_lower:
                # SSRF allowlist breach: never echo the key or full URL.
                raise ConfigurationError("invalid configuration", init_fatal=True)
        if self.local_evaluation and not (
            self.personal_api_key or self.secret_key
        ) and backend_required:
            raise ConfigurationError("invalid configuration", init_fatal=True)
        if self.feature_flags_request_timeout_ms <= 0 or self.shutdown_timeout_ms <= 0:
            raise ConfigurationError("invalid configuration", init_fatal=True)
