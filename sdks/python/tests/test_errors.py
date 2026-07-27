"""Error taxonomy: 15 kinds, OpenFeature mapping, redaction, cause chaining."""

from __future__ import annotations

import pytest

from fireweave.errors import (
    AlreadyClosedError,
    AuthenticationError,
    ConfigurationError,
    ErrorKind,
    FireweaveError,
    FlagNotFoundError,
    InvalidContextError,
    NetworkError,
    NotReadyError,
    RateLimitedError,
    TargetingKeyMissingError,
    TimeoutError_,
    TypeMismatchError,
    default_message,
    openfeature_error_code,
    redact_secrets,
)

EXPECTED_KINDS = {
    "NotReady", "FlagNotFound", "TypeMismatch", "InvalidContext",
    "Authentication", "Authorization", "RateLimited", "Timeout", "Network",
    "BackendUnavailable", "MalformedResponse", "UnsupportedCapability",
    "Configuration", "AlreadyClosed", "Internal",
}


def test_exactly_15_pascalcase_kinds():
    values = {k.value for k in ErrorKind}
    assert values == EXPECTED_KINDS
    assert len(values) == 15


@pytest.mark.parametrize(
    "kind,expected_code",
    [
        (ErrorKind.NOT_READY, "PROVIDER_NOT_READY"),
        (ErrorKind.FLAG_NOT_FOUND, "FLAG_NOT_FOUND"),
        (ErrorKind.TYPE_MISMATCH, "TYPE_MISMATCH"),
        (ErrorKind.INVALID_CONTEXT, "INVALID_CONTEXT"),
        (ErrorKind.MALFORMED_RESPONSE, "PARSE_ERROR"),
        (ErrorKind.ALREADY_CLOSED, "PROVIDER_NOT_READY"),
        (ErrorKind.AUTHENTICATION, "GENERAL"),
        (ErrorKind.RATE_LIMITED, "GENERAL"),
        (ErrorKind.NETWORK, "GENERAL"),
        (ErrorKind.BACKEND_UNAVAILABLE, "GENERAL"),
        (ErrorKind.UNSUPPORTED_CAPABILITY, "GENERAL"),
        (ErrorKind.INTERNAL, "GENERAL"),
    ],
)
def test_openfeature_error_code_mapping(kind, expected_code):
    assert openfeature_error_code(kind) == expected_code


def test_special_case_mappings():
    assert openfeature_error_code(ErrorKind.INVALID_CONTEXT, targeting_key_missing=True) == "TARGETING_KEY_MISSING"
    assert openfeature_error_code(ErrorKind.CONFIGURATION, init_fatal=True) == "PROVIDER_FATAL"
    assert openfeature_error_code(ErrorKind.CONFIGURATION) == "GENERAL"
    assert TargetingKeyMissingError().openfeature_error_code == "TARGETING_KEY_MISSING"
    assert ConfigurationError(init_fatal=True).openfeature_error_code == "PROVIDER_FATAL"
    assert AlreadyClosedError().openfeature_error_code == "PROVIDER_NOT_READY"


def test_retryable_flags():
    assert NotReadyError().retryable
    assert RateLimitedError().retryable
    assert TimeoutError_().retryable
    assert NetworkError().retryable
    assert not TypeMismatchError().retryable
    assert not InvalidContextError().retryable


class TestRedaction:
    @pytest.mark.parametrize(
        "secret",
        [
            "phc_SUPERSECRET0000000000000001",
            "phs_secretserverkey",
            "phx_personalkey",
            "Bearer abc.def.ghi",
        ],
    )
    def test_secret_patterns_redacted(self, secret):
        message = f"request failed with key {secret} attached"
        err = AuthenticationError(message)
        assert secret not in err.message
        assert "[REDACTED]" in err.message

    def test_redact_secrets_handles_none(self):
        assert redact_secrets(None) is None

    def test_default_messages_are_secret_free(self):
        for kind in ErrorKind:
            msg = default_message(kind)
            assert "phc_" not in msg and "phs_" not in msg and "phx_" not in msg

    def test_empty_message_falls_back_to_default(self):
        assert FlagNotFoundError().message == "flag not found"
        assert FlagNotFoundError("").message == "flag not found"


def test_cause_preserved_via_dunder_cause():
    original = ValueError("upstream boom")
    try:
        try:
            raise original
        except ValueError as exc:
            raise NetworkError("network error") from exc
    except NetworkError as caught:
        assert caught.__cause__ is original


def test_flag_not_found_quota_limited_flag():
    err = FlagNotFoundError(quota_limited=True)
    assert err.quota_limited
    assert err.kind is ErrorKind.FLAG_NOT_FOUND


def test_all_errors_subclass_fireweave_error():
    assert issubclass(AuthenticationError, FireweaveError)
    assert issubclass(TargetingKeyMissingError, InvalidContextError)
