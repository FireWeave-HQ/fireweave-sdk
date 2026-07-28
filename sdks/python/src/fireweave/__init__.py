"""Fireweave SDK for Python (spec v0.1.0).

Core installs with zero runtime dependencies. Optional extras:

- ``fireweave[posthog]`` — PostHog backend adapter (``fireweave.adapters.posthog``)
- ``fireweave[openfeature]`` — OpenFeature provider (``fireweave.openfeature``)

Quick start (in-memory, offline)::

    from fireweave import FireweaveClient, FireweaveRuntime, InMemoryAdapter

    adapter = InMemoryAdapter({"my-flag": {"type": "boolean", "enabled": True,
                                           "variant": "on", "value": True}})
    runtime = FireweaveRuntime(adapter)
    runtime.initialize()
    client = FireweaveClient(runtime)
    client.flags.get_boolean_value("my-flag", False)
    client.shutdown()

There are no hidden global clients: everything is constructed explicitly and
injectable for tests.
"""

from ._version import SPEC_VERSION, __version__
from .adapters import BackendAdapter, FlagResolution, FireweaveRemoteAdapter, InMemoryAdapter
from .capabilities import CANONICAL_CAPABILITIES, CapabilityRegistry
from .client import (
    CapabilityResult,
    ExposureResult,
    FireweaveClient,
    FlushResult,
    ReleaseContext,
    ReleaseResult,
    SignalResult,
)
from .config import DEFAULT_ALLOWED_HOSTS, FireweaveConfig
from .context import ContextLimits, EvaluationContext, merge_contexts, validate_context
from .decision import Decision, Reason
from .errors import (
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
)
from .runtime import EvaluationOptions, FireweaveRuntime, LifecycleState
from .types import FlagType, JsonValue

__all__ = [
    "__version__",
    "SPEC_VERSION",
    # runtime / client
    "FireweaveClient",
    "FireweaveRuntime",
    "FireweaveConfig",
    "DEFAULT_ALLOWED_HOSTS",
    "LifecycleState",
    "EvaluationOptions",
    # adapters
    "BackendAdapter",
    "FlagResolution",
    "InMemoryAdapter",
    "FireweaveRemoteAdapter",
    # context / decisions
    "ContextLimits",
    "EvaluationContext",
    "merge_contexts",
    "validate_context",
    "Decision",
    "Reason",
    "FlagType",
    "JsonValue",
    # capabilities
    "CANONICAL_CAPABILITIES",
    "CapabilityRegistry",
    # extension results
    "ReleaseContext",
    "ReleaseResult",
    "ExposureResult",
    "FlushResult",
    "SignalResult",
    "CapabilityResult",
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
]
