"""Fireweave canonical error taxonomy (contracts/errors.json, 15 kinds).

Rules implemented here:

- **Defaults do not throw**: the runtime converts these errors into default-valued
  decisions; OpenFeature resolvers never raise for abnormal evaluation.
- **No secrets in messages**: every message that crosses a public boundary goes
  through :func:`redact_secrets`; error kinds carry canonical safe default
  messages and never echo credentials.
- Causes are preserved idiomatically via ``raise ... from`` (``__cause__``).
"""

from __future__ import annotations

import enum
import re
from typing import Optional

__all__ = [
    "ErrorKind",
    "FireweaveError",
    "NotReadyError",
    "FlagNotFoundError",
    "TypeMismatchError",
    "InvalidContextError",
    "TargetingKeyMissingError",
    "AuthenticationError",
    "AuthorizationError",
    "RateLimitedError",
    "TimeoutError_",
    "NetworkError",
    "BackendUnavailableError",
    "MalformedResponseError",
    "UnsupportedCapabilityError",
    "ConfigurationError",
    "AlreadyClosedError",
    "InternalError",
    "default_message",
    "openfeature_error_code",
    "redact_secrets",
    "FLAG_METADATA_ERROR_KIND_KEY",
]

FLAG_METADATA_ERROR_KIND_KEY = "fireweave.errorKind"


class ErrorKind(str, enum.Enum):
    """Canonical PascalCase error kinds (contracts/errors.json)."""

    NOT_READY = "NotReady"
    FLAG_NOT_FOUND = "FlagNotFound"
    TYPE_MISMATCH = "TypeMismatch"
    INVALID_CONTEXT = "InvalidContext"
    AUTHENTICATION = "Authentication"
    AUTHORIZATION = "Authorization"
    RATE_LIMITED = "RateLimited"
    TIMEOUT = "Timeout"
    NETWORK = "Network"
    BACKEND_UNAVAILABLE = "BackendUnavailable"
    MALFORMED_RESPONSE = "MalformedResponse"
    UNSUPPORTED_CAPABILITY = "UnsupportedCapability"
    CONFIGURATION = "Configuration"
    ALREADY_CLOSED = "AlreadyClosed"
    INTERNAL = "Internal"


_DEFAULT_MESSAGES = {
    ErrorKind.NOT_READY: "provider not ready",
    ErrorKind.FLAG_NOT_FOUND: "flag not found",
    ErrorKind.TYPE_MISMATCH: "flag type mismatch",
    ErrorKind.INVALID_CONTEXT: "invalid evaluation context",
    ErrorKind.AUTHENTICATION: "authentication failed",
    ErrorKind.AUTHORIZATION: "authorization failed",
    ErrorKind.RATE_LIMITED: "rate limited",
    ErrorKind.TIMEOUT: "request timed out",
    ErrorKind.NETWORK: "network error",
    ErrorKind.BACKEND_UNAVAILABLE: "backend unavailable",
    ErrorKind.MALFORMED_RESPONSE: "malformed backend response",
    ErrorKind.UNSUPPORTED_CAPABILITY: "unsupported capability",
    ErrorKind.CONFIGURATION: "invalid configuration",
    ErrorKind.ALREADY_CLOSED: "provider already closed",
    ErrorKind.INTERNAL: "internal error",
}

# OpenFeature error-code strings (ADR-0001 §12). ``Configuration`` maps to
# PROVIDER_FATAL on the init-fatal path and GENERAL at runtime;
# ``InvalidContext`` maps to TARGETING_KEY_MISSING when the targeting key is
# required and missing.
_OF_ERROR_CODES = {
    ErrorKind.NOT_READY: "PROVIDER_NOT_READY",
    ErrorKind.FLAG_NOT_FOUND: "FLAG_NOT_FOUND",
    ErrorKind.TYPE_MISMATCH: "TYPE_MISMATCH",
    ErrorKind.INVALID_CONTEXT: "INVALID_CONTEXT",
    ErrorKind.AUTHENTICATION: "GENERAL",
    ErrorKind.AUTHORIZATION: "GENERAL",
    ErrorKind.RATE_LIMITED: "GENERAL",
    ErrorKind.TIMEOUT: "GENERAL",
    ErrorKind.NETWORK: "GENERAL",
    ErrorKind.BACKEND_UNAVAILABLE: "GENERAL",
    ErrorKind.MALFORMED_RESPONSE: "PARSE_ERROR",
    ErrorKind.UNSUPPORTED_CAPABILITY: "GENERAL",
    ErrorKind.CONFIGURATION: "GENERAL",  # runtime path; init-fatal → PROVIDER_FATAL
    ErrorKind.ALREADY_CLOSED: "PROVIDER_NOT_READY",
    ErrorKind.INTERNAL: "GENERAL",
}

_RETRYABLE = {
    ErrorKind.NOT_READY,
    ErrorKind.RATE_LIMITED,
    ErrorKind.TIMEOUT,
    ErrorKind.NETWORK,
    ErrorKind.BACKEND_UNAVAILABLE,
}

# Secret redaction: prefix-token patterns per contracts/errors.json rules.
_SECRET_PATTERNS = re.compile(
    r"(phc_[A-Za-z0-9_\-]*|phs_[A-Za-z0-9_\-]*|phx_[A-Za-z0-9_\-]*"
    r"|Bearer\s+\S+|FW_PROJECT_API_KEY\s*[=:]\s*\S+)"
)


def redact_secrets(text: Optional[str]) -> Optional[str]:
    """Redact secret-shaped substrings and collapse whitespace runs."""
    if text is None:
        return None
    redacted = _SECRET_PATTERNS.sub("[REDACTED]", text)
    return re.sub(r"\s+", " ", redacted).strip()


def default_message(kind: ErrorKind) -> str:
    """Canonical safe default message for an error kind."""
    return _DEFAULT_MESSAGES[kind]


def openfeature_error_code(
    kind: ErrorKind,
    *,
    targeting_key_missing: bool = False,
    init_fatal: bool = False,
) -> str:
    """Map a Fireweave error kind to an OpenFeature error code string."""
    if kind is ErrorKind.INVALID_CONTEXT and targeting_key_missing:
        return "TARGETING_KEY_MISSING"
    if kind is ErrorKind.CONFIGURATION and init_fatal:
        return "PROVIDER_FATAL"
    return _OF_ERROR_CODES[kind]


class FireweaveError(Exception):
    """Base class for all Fireweave errors.

    Instances carry the canonical ``kind`` and a secret-safe ``message``.
    Constructors run the message through :func:`redact_secrets` defensively.
    """

    kind: ErrorKind = ErrorKind.INTERNAL

    def __init__(self, message: Optional[str] = None, *, kind: Optional[ErrorKind] = None):
        if kind is not None:
            self.kind = kind
        self.message: str = redact_secrets(message) or default_message(self.kind)
        super().__init__(self.message)

    @property
    def retryable(self) -> bool:
        return self.kind in _RETRYABLE

    @property
    def openfeature_error_code(self) -> str:
        return openfeature_error_code(self.kind)


class NotReadyError(FireweaveError):
    kind = ErrorKind.NOT_READY


class FlagNotFoundError(FireweaveError):
    kind = ErrorKind.FLAG_NOT_FOUND

    def __init__(self, message: Optional[str] = None, *, quota_limited: bool = False):
        super().__init__(message)
        self.quota_limited = quota_limited


class TypeMismatchError(FireweaveError):
    kind = ErrorKind.TYPE_MISMATCH


class InvalidContextError(FireweaveError):
    kind = ErrorKind.INVALID_CONTEXT


class TargetingKeyMissingError(InvalidContextError):
    """InvalidContext subtype: OF code TARGETING_KEY_MISSING."""

    def __init__(self, message: Optional[str] = None):
        super().__init__(message or "targeting key missing")

    @property
    def openfeature_error_code(self) -> str:
        return "TARGETING_KEY_MISSING"


class AuthenticationError(FireweaveError):
    kind = ErrorKind.AUTHENTICATION


class AuthorizationError(FireweaveError):
    kind = ErrorKind.AUTHORIZATION


class RateLimitedError(FireweaveError):
    kind = ErrorKind.RATE_LIMITED


class TimeoutError_(FireweaveError):
    """Named with a trailing underscore to avoid shadowing builtins.TimeoutError."""

    kind = ErrorKind.TIMEOUT


class NetworkError(FireweaveError):
    kind = ErrorKind.NETWORK


class BackendUnavailableError(FireweaveError):
    kind = ErrorKind.BACKEND_UNAVAILABLE


class MalformedResponseError(FireweaveError):
    kind = ErrorKind.MALFORMED_RESPONSE


class UnsupportedCapabilityError(FireweaveError):
    kind = ErrorKind.UNSUPPORTED_CAPABILITY


class ConfigurationError(FireweaveError):
    kind = ErrorKind.CONFIGURATION

    def __init__(self, message: Optional[str] = None, *, init_fatal: bool = False):
        super().__init__(message)
        self.init_fatal = init_fatal

    @property
    def openfeature_error_code(self) -> str:
        return openfeature_error_code(self.kind, init_fatal=self.init_fatal)


class AlreadyClosedError(FireweaveError):
    kind = ErrorKind.ALREADY_CLOSED


class InternalError(FireweaveError):
    kind = ErrorKind.INTERNAL
