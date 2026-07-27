"""In-memory testing example for the FastAPI app.

No network, no PostHog: inject an InMemoryAdapter with exactly the flag state
the test needs. Requires: pip install fastapi httpx pytest

    pytest test_fastapi_app.py
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

from fastapi.testclient import TestClient

import fastapi_app
from fastapi_app import app
from fireweave import InMemoryAdapter


@contextmanager
def make_test_client(flags: dict) -> Iterator[TestClient]:
    """Route the app's adapter factory at a deterministic in-memory adapter.

    The patch must stay active while the TestClient context runs the app
    lifespan (that's when the adapter is actually constructed).
    """
    original = fastapi_app.build_adapter
    fastapi_app.build_adapter = lambda: InMemoryAdapter(flags)
    try:
        with TestClient(app) as client:
            yield client
    finally:
        fastapi_app.build_adapter = original


def test_new_checkout_on_for_gold_tier():
    flags = {
        "new-checkout": {"type": "boolean", "enabled": True,
                         "variant": "on", "value": True},
        "checkout-theme": {"type": "string", "enabled": True, "variant": "dark",
                           "value": "dark", "matchAttribute": {"tier": "gold"}},
    }
    with make_test_client(flags) as client:
        body = client.get("/checkout", params={"user_id": "u1", "tier": "gold"}).json()
        assert body == {"checkout": "v2", "theme": "dark"}


def test_missing_flag_degrades_to_default_with_error_details():
    with make_test_client({}) as client:
        body = client.get("/flags/new-checkout", params={"user_id": "u1"}).json()
        assert body["value"] is False
        assert body["errorKind"] == "FlagNotFound"
        assert body["reason"] == "ERROR"


def test_clean_shutdown_on_app_exit():
    flags = {"new-checkout": {"type": "boolean", "enabled": True,
                              "variant": "on", "value": True}}
    with make_test_client(flags) as client:
        assert client.get("/health").json()["sdkState"] == "READY"
        fw = app.state.fireweave
    # TestClient exit runs the lifespan teardown -> client.shutdown().
    assert fw.runtime.state.wire_name == "CLOSED"
