"""Fireweave SDK for Python (spec v0.1.0).

Exactly two v1 capabilities (spec/control-points.md "Scope of v1"): control
points and target registration. Zero runtime dependencies.

Quick start (in-memory, offline)::

    from fireweave import FireweaveClient, FireweaveRuntime, InMemoryAdapter

    adapter = InMemoryAdapter({"my-flag": {"enabled": True, "variant": "on", "value": True}})
    runtime = FireweaveRuntime(adapter)
    runtime.initialize()
    client = FireweaveClient(runtime)
    client.control_points.get_boolean_value("my-flag", False)
    client.shutdown()

Or, through the single entry point (spec/modes.md)::

    from fireweave import init_fireweave

    client = init_fireweave(mode="local", local={"control_points": {"my-flag": True}})
    client.control_points.get_boolean_value("my-flag", False)
    client.shutdown()

There are no hidden global clients: everything is constructed explicitly and
injectable for tests.
"""

from ._version import SPEC_VERSION, __version__
from .domain.context import (
    ALLOWED_FIREWEAVE_CONTEXT_KEYS,
    DEFAULT_CONTEXT_LIMITS,
    DEFAULT_RESERVED_ATTRIBUTE_KEYS,
    ContextLimits,
    EvaluationContext,
    merge_contexts,
)
from .domain.decision import Decision, Reason
from .domain.errors import (
    AlreadyClosedError,
    AuthenticationError,
    AuthorizationError,
    BackendUnavailableError,
    ConfigurationError,
    ErrorKind,
    FireweaveError,
    FlagNotFoundError,
    InternalError,
    InvalidContextError,
    MalformedResponseError,
    NetworkError,
    NotReadyError,
    RateLimitedError,
    TargetingKeyMissingError,
    TimeoutError_,
    TypeMismatchError,
    UnsupportedCapabilityError,
    default_message,
    openfeature_error_code,
    redact_secrets,
)
from .domain.target import TargetKind
from .domain.types import FlagType, JsonValue
from .domain.validation import (
    Validated,
    matches_expected_type,
    validate_context,
    validate_control_point_key,
    validate_default_value,
    validate_init_options,
    validate_targeting_key,
)
from .application.client import ExtensionResult, FireweaveClient
from .application.mode import init_fireweave
from .application.ports import BackendAdapter, FlagResolution, RegisterTargetOptions, RegisterTargetResult
from .application.runtime import DEFAULT_SHUTDOWN_TIMEOUT_MS, FireweaveRuntime, LifecycleState
from .infrastructure.adapters.local import FireweaveLocalAdapter, LocalRegisteredTarget
from .infrastructure.adapters.memory import InMemoryAdapter
from .infrastructure.adapters.remote import FireweaveRemoteAdapter
from .infrastructure.hosts import DEFAULT_ALLOWED_HOSTS, assert_host_allowed, is_loopback_hostname

__all__ = [
    "__version__",
    "SPEC_VERSION",
    # runtime / client / entry point
    "init_fireweave",
    "FireweaveClient",
    "ExtensionResult",
    "FireweaveRuntime",
    "LifecycleState",
    "DEFAULT_SHUTDOWN_TIMEOUT_MS",
    # adapters
    "BackendAdapter",
    "FlagResolution",
    "RegisterTargetOptions",
    "RegisterTargetResult",
    "InMemoryAdapter",
    "FireweaveLocalAdapter",
    "LocalRegisteredTarget",
    "FireweaveRemoteAdapter",
    "DEFAULT_ALLOWED_HOSTS",
    "assert_host_allowed",
    "is_loopback_hostname",
    # context
    "ContextLimits",
    "DEFAULT_CONTEXT_LIMITS",
    "DEFAULT_RESERVED_ATTRIBUTE_KEYS",
    "ALLOWED_FIREWEAVE_CONTEXT_KEYS",
    "EvaluationContext",
    "merge_contexts",
    # decisions / types
    "Decision",
    "Reason",
    "FlagType",
    "JsonValue",
    "TargetKind",
    # validation
    "Validated",
    "matches_expected_type",
    "validate_control_point_key",
    "validate_default_value",
    "validate_context",
    "validate_targeting_key",
    "validate_init_options",
    # errors
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
]
