"""Lifecycle state machine and never-throw evaluation semantics."""

from __future__ import annotations

import pytest

from fireweave import (
    ConfigurationError,
    EvaluationContext,
    FireweaveConfig,
    FireweaveRuntime,
    FlagType,
    InMemoryAdapter,
    LifecycleState,
)
from fireweave.errors import ErrorKind

FLAGS = {
    "f": {"type": "boolean", "enabled": True, "variant": "on", "value": True}
}


def make_runtime(config: FireweaveConfig | None = None) -> FireweaveRuntime:
    return FireweaveRuntime(InMemoryAdapter(FLAGS), config)


def test_initial_state_not_ready():
    rt = make_runtime()
    assert rt.state is LifecycleState.UNINITIALIZED
    assert rt.state.wire_name == "NOT_READY"


def test_evaluate_before_init_returns_default_not_ready():
    d = make_runtime().evaluate("f", FlagType.BOOLEAN, False, EvaluationContext("u"))
    assert d.value is False
    assert d.error_kind is ErrorKind.NOT_READY
    assert d.error_code == "PROVIDER_NOT_READY"


def test_initialize_transitions_to_ready():
    rt = make_runtime()
    rt.initialize()
    assert rt.state is LifecycleState.READY
    d = rt.evaluate("f", FlagType.BOOLEAN, False, EvaluationContext("u"))
    assert d.value is True and d.reason == "TARGETING_MATCH"


def test_initialize_is_idempotent_when_ready():
    rt = make_runtime()
    rt.initialize()
    rt.initialize()
    assert rt.state is LifecycleState.READY


def test_invalid_config_init_goes_fatal():
    rt = make_runtime(FireweaveConfig(project_api_key="", host="not-a-uri"))
    with pytest.raises(ConfigurationError) as exc_info:
        rt.initialize(backend_required=True)
    assert rt.state is LifecycleState.FATAL
    assert exc_info.value.openfeature_error_code == "PROVIDER_FATAL"
    # Evaluation in FATAL degrades to default, does not raise.
    d = rt.evaluate("f", FlagType.BOOLEAN, False, EvaluationContext("u"))
    assert d.value is False and d.error_kind is ErrorKind.CONFIGURATION


def test_ssrf_allowlist_rejects_unlisted_host():
    cfg = FireweaveConfig(
        project_api_key="phc_TESTKEY0000000000000000000002",
        host="http://169.254.169.254",
        allowed_hosts=("127.0.0.1", "localhost", "us.i.posthog.com"),
    )
    rt = make_runtime(cfg)
    with pytest.raises(ConfigurationError) as exc_info:
        rt.initialize(backend_required=True)
    assert "phc_" not in exc_info.value.message
    assert rt.state is LifecycleState.FATAL


def test_shutdown_from_ready():
    rt = make_runtime()
    rt.initialize()
    rt.shutdown()
    assert rt.state is LifecycleState.SHUTDOWN
    assert rt.state.wire_name == "CLOSED"


def test_shutdown_idempotent():
    rt = make_runtime()
    rt.initialize()
    rt.shutdown()
    rt.shutdown()  # must not raise
    assert rt.state is LifecycleState.SHUTDOWN


def test_evaluate_after_shutdown_already_closed():
    rt = make_runtime()
    rt.initialize()
    rt.shutdown()
    d = rt.evaluate("f", FlagType.BOOLEAN, False, EvaluationContext("u"))
    assert d.value is False
    assert d.error_kind is ErrorKind.ALREADY_CLOSED
    assert d.error_code == "PROVIDER_NOT_READY"  # AlreadyClosed -> PROVIDER_NOT_READY


def test_stale_state_marks_reason_stale():
    rt = make_runtime()
    rt.initialize()
    rt.mark_stale()
    assert rt.state is LifecycleState.STALE
    d = rt.evaluate("f", FlagType.BOOLEAN, False, EvaluationContext("u"))
    assert d.value is True and d.reason == "STALE"


def test_vendor_exception_during_init_wrapped_with_cause():
    class ExplodingAdapter(InMemoryAdapter):
        def initialize(self):
            raise RuntimeError("vendor boom")

    rt = FireweaveRuntime(ExplodingAdapter())
    with pytest.raises(Exception) as exc_info:
        rt.initialize()
    assert rt.state is LifecycleState.FATAL
    assert isinstance(exc_info.value.__cause__, RuntimeError)


def test_adapter_exception_during_resolve_becomes_internal_decision():
    class ExplodingAdapter(InMemoryAdapter):
        def resolve(self, flag_key, context):
            raise RuntimeError("vendor boom")

    rt = FireweaveRuntime(ExplodingAdapter())
    rt.initialize()
    d = rt.evaluate("f", FlagType.BOOLEAN, False, EvaluationContext("u"))
    assert d.value is False
    assert d.error_kind is ErrorKind.INTERNAL
    assert "boom" not in (d.error_message or "")  # vendor text not echoed
