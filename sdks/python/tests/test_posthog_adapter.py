"""PostHogAdapter: fake vendor client, transport error mapping, public-API purity."""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional

import pytest
import requests

from fireweave import (
    EvaluationContext,
    FireweaveConfig,
    FireweaveRuntime,
    FlagType,
    FlagNotFoundError,
)
from fireweave.adapters.posthog import (
    PostHogAdapter,
    map_transport_error,
)
from fireweave.errors import (
    AuthenticationError,
    AuthorizationError,
    BackendUnavailableError,
    ErrorKind,
    MalformedResponseError,
    NetworkError,
    RateLimitedError,
    TimeoutError_,
)


# --- fakes -----------------------------------------------------------------


@dataclass
class _FakeRecord:
    enabled: bool
    variant: Optional[str] = None
    payload: Optional[Any] = None
    id: Optional[int] = None
    version: Optional[int] = None
    reason: Optional[str] = None
    locally_evaluated: bool = False


class FakeSnapshot:
    def __init__(self, flags: Dict[str, _FakeRecord], quota_limited: bool = False):
        self._flags = flags
        self._quota_limited = quota_limited
        self._errors_while_computing = False


class FakePostHogClient:
    """Minimal fake of posthog.Posthog used through the adapter's boundary."""

    def __init__(self, flags: Dict[str, _FakeRecord], quota_limited: bool = False):
        self.flags = flags
        self.quota_limited = quota_limited
        self.evaluate_calls: list = []
        self.captured: list = []
        self.flushed = False
        self.shut_down = False

    def evaluate_flags(self, distinct_id, *, groups=None, person_properties=None,
                       group_properties=None, only_evaluate_locally=False):
        self.evaluate_calls.append(
            {
                "distinct_id": distinct_id,
                "groups": groups,
                "person_properties": person_properties,
                "group_properties": group_properties,
                "only_evaluate_locally": only_evaluate_locally,
            }
        )
        return FakeSnapshot(self.flags, self.quota_limited)

    def capture(self, **kwargs):
        self.captured.append(kwargs)

    def flush(self):
        self.flushed = True

    def shutdown(self):
        self.shut_down = True


def make_adapter(fake_client: FakePostHogClient, **cfg: Any) -> PostHogAdapter:
    adapter = PostHogAdapter(client=fake_client, config=FireweaveConfig(**cfg))
    adapter.initialize()
    return adapter


# --- snapshot mapping ---------------------------------------------------------


class TestSnapshotMapping:
    def test_targeting_key_maps_to_distinct_id(self):
        fake = FakePostHogClient({"f": _FakeRecord(enabled=True)})
        adapter = make_adapter(fake)
        adapter.resolve("f", EvaluationContext("user_42", {"plan": "pro"}))
        call = fake.evaluate_calls[0]
        assert call["distinct_id"] == "user_42"
        assert call["person_properties"] == {"plan": "pro"}

    def test_groups_and_group_properties_forwarded(self):
        fake = FakePostHogClient({"f": _FakeRecord(enabled=True)})
        adapter = make_adapter(fake)
        ctx = EvaluationContext(
            "u",
            {
                "groups": {"organization": "org_1"},
                "groupProperties": {"organization": {"plan": "enterprise"}},
            },
        )
        adapter.resolve("f", ctx)
        call = fake.evaluate_calls[0]
        assert call["groups"] == {"organization": "org_1"}
        assert call["group_properties"] == {"organization": {"plan": "enterprise"}}
        # groups are not duplicated into person properties
        assert "groups" not in (call["person_properties"] or {})

    def test_boolean_gate_value(self):
        fake = FakePostHogClient({"f": _FakeRecord(enabled=True, version=3)})
        res = make_adapter(fake).resolve("f", EvaluationContext("u"))
        assert res.value is True and res.enabled and res.version == 3

    def test_variant_value_and_metadata(self):
        fake = FakePostHogClient(
            {"f": _FakeRecord(enabled=True, variant="treatment-b", id=7, version=2,
                              reason="condition_match")}
        )
        res = make_adapter(fake).resolve("f", EvaluationContext("u"))
        assert res.value == "treatment-b"
        assert res.variant == "treatment-b"
        assert res.vendor_flag_id == 7
        assert res.reason_code == "condition_match"

    def test_json_string_payload_decoded(self):
        fake = FakePostHogClient(
            {"f": _FakeRecord(enabled=True, payload=json.dumps({"mode": "safe"}))}
        )
        res = make_adapter(fake).resolve("f", EvaluationContext("u"))
        assert res.value == {"mode": "safe"}
        assert res.payload == {"mode": "safe"}

    def test_missing_flag_raises_flag_not_found(self):
        fake = FakePostHogClient({})
        with pytest.raises(FlagNotFoundError):
            make_adapter(fake).resolve("nope", EvaluationContext("u"))

    def test_quota_limited_marks_flag_not_found(self):
        fake = FakePostHogClient({}, quota_limited=True)
        with pytest.raises(FlagNotFoundError) as exc_info:
            make_adapter(fake).resolve("f", EvaluationContext("u"))
        assert exc_info.value.quota_limited

    def test_local_eval_mode_flag_forwarded(self):
        fake = FakePostHogClient({"f": _FakeRecord(enabled=True)})
        adapter = make_adapter(fake, only_evaluate_locally=True, local_evaluation=True,
                               secret_key="phs_x")
        adapter.resolve("f", EvaluationContext("u"))
        assert fake.evaluate_calls[0]["only_evaluate_locally"] is True


# --- transport error mapping ---------------------------------------------------


def _http_error(status: int) -> requests.exceptions.HTTPError:
    response = requests.models.Response()
    response.status_code = status
    return requests.exceptions.HTTPError(response=response)


@pytest.mark.parametrize(
    "exc,expected",
    [
        (_http_error(401), AuthenticationError),
        (_http_error(403), AuthorizationError),
        (_http_error(429), RateLimitedError),
        (_http_error(500), BackendUnavailableError),
        (_http_error(503), BackendUnavailableError),
        (requests.exceptions.ConnectTimeout(), TimeoutError_),
        (requests.exceptions.ReadTimeout(), TimeoutError_),
        (requests.exceptions.ConnectionError("reset"), NetworkError),
        (json.JSONDecodeError("bad", "{not-json", 1), MalformedResponseError),
    ],
)
def test_map_transport_error(exc, expected):
    mapped = map_transport_error(exc)
    assert isinstance(mapped, expected)
    assert mapped.__cause__ is exc


def test_mapped_errors_use_safe_messages():
    exc = requests.exceptions.ConnectionError(
        "POST https://x/flags?token=phc_SECRET failed"
    )
    mapped = map_transport_error(exc)
    assert "phc_" not in mapped.message


# --- ownership / lifecycle ------------------------------------------------------


def test_injected_client_not_shut_down():
    fake = FakePostHogClient({"f": _FakeRecord(enabled=True)})
    adapter = make_adapter(fake)
    adapter.shutdown(1000)
    assert not fake.shut_down and not fake.flushed


def _owned_adapter_with(client: Any) -> PostHogAdapter:
    """Adapter that OWNS a (fake) vendor client, bypassing the real builder."""
    adapter = PostHogAdapter(
        config=FireweaveConfig(
            project_api_key="phc_TESTKEY0000000000000000000001",
            host="https://us.i.posthog.com",
        )
    )
    adapter._build_client = lambda: client  # type: ignore[method-assign]
    adapter.initialize()
    return adapter


def test_shutdown_enforces_configured_timeout():
    """M-1: a wedged vendor flush must not hang shutdown past timeout_ms."""

    class HangingClient:
        def __init__(self):
            self.flush_started = threading.Event()

        def flush(self):
            self.flush_started.set()
            time.sleep(30)

        def shutdown(self):  # pragma: no cover - never reached (flush hangs)
            pass

    hanging = HangingClient()
    adapter = _owned_adapter_with(hanging)
    start = time.monotonic()
    adapter.shutdown(200)
    elapsed = time.monotonic() - start
    assert hanging.flush_started.is_set()
    assert elapsed < 5.0  # bounded by the 200 ms budget, not the 30 s hang


def test_shutdown_completes_promptly_within_budget():
    fake = FakePostHogClient({})
    adapter = _owned_adapter_with(fake)
    adapter.shutdown(10_000)
    assert fake.flushed and fake.shut_down


# --- vendor bounds (M-5) --------------------------------------------------------


def test_build_client_pins_vendor_retry_and_queue_caps(monkeypatch):
    import posthog

    captured: Dict[str, Any] = {}

    class FakeVendor:
        def __init__(self, project_api_key, **kwargs):
            captured["project_api_key"] = project_api_key
            captured.update(kwargs)

    monkeypatch.setattr(posthog, "Posthog", FakeVendor)
    adapter = PostHogAdapter(
        config=FireweaveConfig(
            project_api_key="phc_TESTKEY0000000000000000000001",
            host="https://us.i.posthog.com",
        )
    )
    adapter._build_client()
    assert captured["feature_flags_request_max_retries"] == 0  # match Node/Go
    assert captured["max_retries"] == 0
    assert captured["max_queue_size"] == 10_000


def test_vendor_client_signature_accepts_pinned_caps():
    """Guard against vendor-pin drift: posthog==7.31.0 must accept our caps."""
    import inspect

    from posthog import Posthog

    params = inspect.signature(Posthog.__init__).parameters
    for kwarg in (
        "feature_flags_request_max_retries",
        "max_retries",
        "max_queue_size",
        "feature_flags_request_timeout_seconds",
        "enable_local_evaluation",
        "sync_mode",
    ):
        assert kwarg in params, f"posthog pin no longer accepts {kwarg}"


def test_runtime_features_mirror_vendor_bounds():
    adapter = make_adapter(FakePostHogClient({}))
    features = adapter.runtime_features()
    assert features["vendorRetriesDisabled"] is True
    assert features["boundedTelemetryQueue"] is True
    assert features["exposureEmission"] is False
    assert features["sideEffectFreeReads"] is True


# --- telemetry sink (ruling 17) ---------------------------------------------------


def test_deliver_signal_uses_capture():
    fake = FakePostHogClient({})
    adapter = make_adapter(fake)
    adapter.deliver_signal(
        {"kind": "health", "name": "provider", "status": "ok",
         "rolloutId": "rollout_01H"}
    )
    assert fake.captured[0]["event"] == "$fw_signal_health"
    assert fake.captured[0]["distinct_id"] == "rollout_01H"
    assert fake.captured[0]["properties"]["status"] == "ok"


def test_deliver_release_uses_capture():
    fake = FakePostHogClient({})
    adapter = make_adapter(fake)
    adapter.deliver_release({"rolloutId": "rollout_01H", "status": "in_progress"})
    assert fake.captured[0]["event"] == "$fw_release_in_progress"


def test_sink_swallows_vendor_capture_errors():
    class ExplodingCapture(FakePostHogClient):
        def capture(self, **kwargs):
            raise RuntimeError("vendor boom")

    adapter = make_adapter(ExplodingCapture({}))
    adapter.deliver_signal({"kind": "health", "name": "n"})  # must not raise
    adapter.deliver_release({"rolloutId": "r", "status": "failed"})  # must not raise


def test_adapter_requires_some_configuration():
    from fireweave.errors import ConfigurationError

    with pytest.raises(ConfigurationError):
        PostHogAdapter()


def test_send_exposures_uses_capture():
    fake = FakePostHogClient({"f": _FakeRecord(enabled=True)})
    adapter = make_adapter(fake)
    adapter.send_exposures(
        [{"targetingKey": "u", "flagKey": "f", "variant": "on", "value": True}]
    )
    assert fake.captured[0]["event"] == "$feature_flag_called"
    assert fake.captured[0]["properties"]["$feature_flag"] == "f"


# --- integration through the runtime ---------------------------------------------


def test_runtime_end_to_end_with_fake_posthog():
    fake = FakePostHogClient(
        {"theme": _FakeRecord(enabled=True, variant="dark", version=2,
                              reason="condition_match")}
    )
    runtime = FireweaveRuntime(make_adapter(fake))
    runtime.initialize()
    d = runtime.evaluate("theme", FlagType.STRING, "light", EvaluationContext("u"))
    assert d.value == "dark"
    assert d.reason == "TARGETING_MATCH"
    assert d.flag_metadata["fireweave.flagVersion"] == 2


def test_quota_limited_decision_metadata():
    fake = FakePostHogClient({}, quota_limited=True)
    runtime = FireweaveRuntime(make_adapter(fake))
    runtime.initialize()
    d = runtime.evaluate("f", FlagType.BOOLEAN, False, EvaluationContext("u"))
    assert d.error_kind is ErrorKind.FLAG_NOT_FOUND
    assert d.flag_metadata.get("fireweave.quotaLimited") is True


# --- public API purity -------------------------------------------------------------


def test_no_posthog_types_in_public_api():
    """The public surface must not reference posthog types anywhere."""
    import inspect

    import fireweave
    import fireweave.adapters.posthog as adapter_module

    # 1) Nothing exported from the top-level package comes from posthog.
    for name in fireweave.__all__:
        obj = getattr(fireweave, name)
        module = getattr(obj, "__module__", "") or ""
        assert not module.startswith("posthog"), f"{name} leaks a posthog type"

    # 2) The adapter's public callables have no posthog types in annotations.
    for _, obj in inspect.getmembers(adapter_module):
        if inspect.isclass(obj) and obj.__module__ == adapter_module.__name__:
            for _, meth in inspect.getmembers(obj, inspect.isfunction):
                if meth.__name__.startswith("_"):
                    continue
                for annotation in meth.__annotations__.values():
                    assert "posthog" not in str(annotation).lower()

    # 3) FlagResolution (the boundary record) carries only stdlib types.
    from fireweave.adapters.base import FlagResolution

    for annotation in FlagResolution.__annotations__.values():
        assert "posthog" not in str(annotation).lower()
