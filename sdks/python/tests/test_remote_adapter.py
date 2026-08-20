"""Unit tests for FireweaveRemoteAdapter (mocked transport)."""

from __future__ import annotations

import pytest

from fireweave import AuthenticationError, ConfigurationError, EvaluationContext, FireweaveRemoteAdapter


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
