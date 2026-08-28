"""Unit tests for FireweaveRemoteAdapter (mocked transport)."""

from __future__ import annotations

import pytest

from fireweave import (
    AuthenticationError,
    ConfigurationError,
    EvaluationContext,
    FireweaveRemoteAdapter,
    FlagNotFoundError,
)


def test_initialize_requires_url_and_key():
    adapter = FireweaveRemoteAdapter()
    with pytest.raises(ConfigurationError):
        adapter.initialize()


def test_resolve_via_transport():
    calls = []

    def transport(url, body, headers, timeout):
        calls.append((url, body, headers))
        return 200, {
            "decisions": [
                {
                    "flagKey": "checkout-v2",
                    "value": True,
                    "reason": "TARGETING_MATCH",
                    "found": True,
                    "enabled": True,
                }
            ]
        }

    adapter = FireweaveRemoteAdapter(
        api_url="http://127.0.0.1:3901",
        api_key="project-api-key_test",
        transport=transport,
    )
    adapter.initialize()
    res = adapter.resolve(
        "checkout-v2", EvaluationContext(targeting_key="user-1", attributes={"plan": "pro"})
    )
    assert res.matched is True
    assert res.value is True
    assert calls[0][0].endswith("/v1/flags/evaluate")
    assert calls[0][2]["Authorization"] == "Bearer project-api-key_test"
    assert calls[0][1]["targetingKey"] == "user-1"
    adapter.shutdown(1000)


def test_auth_error():
    adapter = FireweaveRemoteAdapter(
        api_url="http://127.0.0.1:3901",
        api_key="bad",
        transport=lambda *a: (401, {"ok": False}),
    )
    adapter.initialize()
    with pytest.raises(AuthenticationError):
        adapter.resolve("x", EvaluationContext(targeting_key="u"))
    adapter.shutdown(1000)


class TestFlagNotFound:
    """spec/control-points.md return-discipline table, remote's row: "key
    unknown to the backend" -> ERROR/FlagNotFound. This is the fix
    ratified in review — the adapter previously returned
    `FlagResolution(matched=False)` for BOTH this case and local mode's
    genuinely-different "no decision, use the caller's default" case,
    which silently produced the wrong (DEFAULT) reason here. Both raising
    shapes the backend can send are covered: an explicit `found: False`
    item, and the key simply missing from `decisions` altogether."""

    @staticmethod
    def _ready_adapter(transport) -> FireweaveRemoteAdapter:
        adapter = FireweaveRemoteAdapter(
            api_url="http://127.0.0.1:3901",
            api_key="project-api-key_test",
            transport=transport,
        )
        adapter.initialize()
        return adapter

    def test_explicit_found_false_raises_flag_not_found(self):
        adapter = self._ready_adapter(
            lambda *a: (
                200,
                {"decisions": [{"flagKey": "missing", "found": False}]},
            )
        )
        with pytest.raises(FlagNotFoundError) as exc_info:
            adapter.resolve("missing", EvaluationContext(targeting_key="u"))
        assert exc_info.value.quota_limited is False
        adapter.shutdown(1000)

    def test_key_absent_from_decisions_raises_flag_not_found(self):
        adapter = self._ready_adapter(lambda *a: (200, {"decisions": []}))
        with pytest.raises(FlagNotFoundError):
            adapter.resolve("missing", EvaluationContext(targeting_key="u"))
        adapter.shutdown(1000)

    def test_quota_limited_propagates_onto_the_raised_error(self):
        adapter = self._ready_adapter(
            lambda *a: (200, {"decisions": [], "quotaLimited": True})
        )
        with pytest.raises(FlagNotFoundError) as exc_info:
            adapter.resolve("missing", EvaluationContext(targeting_key="u"))
        assert exc_info.value.quota_limited is True
        adapter.shutdown(1000)

    def test_found_true_does_not_raise(self):
        """Control: the fix must not turn a genuine hit into a false miss."""
        adapter = self._ready_adapter(
            lambda *a: (
                200,
                {
                    "decisions": [
                        {"flagKey": "present", "found": True, "value": True, "enabled": True, "reason": "TARGETING_MATCH"}
                    ]
                },
            )
        )
        res = adapter.resolve("present", EvaluationContext(targeting_key="u"))
        assert res.matched is True and res.value is True
        adapter.shutdown(1000)
