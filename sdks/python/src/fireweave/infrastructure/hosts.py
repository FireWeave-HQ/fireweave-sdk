"""Backend host allowlist (SSRF guard).

The allowlist is ON by default: when no explicit `allowed_hosts` is
configured, only the canonical Fireweave hosts plus loopback are permitted,
so a typo'd or tampered host cannot be aimed at cloud metadata endpoints.
Custom/self-hosted deployments require an explicit `allowed_hosts` entry;
``("*",)`` opts out entirely.

Scheme policy: https is required for non-loopback hosts; plain http is
permitted on loopback only.
"""

from __future__ import annotations

from typing import Optional, Sequence
from urllib.parse import urlparse

from ..domain.errors import ConfigurationError

__all__ = ["DEFAULT_ALLOWED_HOSTS", "is_loopback_hostname", "assert_host_allowed"]

# Canonical default host allowlist: Fireweave's own fw-server hostnames plus
# loopback. An unconfigured allowlist denies everything it does not name.
DEFAULT_ALLOWED_HOSTS: tuple = (
    "app-server.fireweave.ai",
    "staging-app-server.fireweave.ai",
    "localhost",
    "127.0.0.1",
    "::1",
)

_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def is_loopback_hostname(hostname: str) -> bool:
    """True for loopback hostnames (http and test stubs are permitted here)."""
    return hostname in _LOOPBACK_HOSTS


def assert_host_allowed(host: str, allowed_hosts: Optional[Sequence[str]] = None) -> None:
    """Validate a backend host URL against the allowlist.

    Raises ``ConfigurationError`` — fixed message, no host echo.
    """
    try:
        parsed = urlparse(host)
    except ValueError as exc:
        raise ConfigurationError() from exc

    hostname = (parsed.hostname or "").lower()
    if parsed.scheme not in ("http", "https") or not hostname:
        raise ConfigurationError()

    loopback = is_loopback_hostname(hostname)
    if parsed.scheme == "http" and not loopback:
        # https required for anything that leaves the machine.
        raise ConfigurationError()

    allow = list(allowed_hosts) if allowed_hosts else list(DEFAULT_ALLOWED_HOSTS)
    if "*" in allow:
        return  # explicit opt-out
    allow_lower = {h.lower() for h in allow}
    if hostname not in allow_lower:
        raise ConfigurationError()
