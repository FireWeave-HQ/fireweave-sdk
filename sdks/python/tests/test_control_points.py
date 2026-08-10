"""Control-points vocabulary alias (ADR-0007) for the Python SDK."""

from __future__ import annotations

import warnings

from fireweave import FireweaveClient, FireweaveRuntime, InMemoryAdapter


def test_control_points_is_flags_alias(client):
    assert client.flags is client.control_points
    assert client.control_points.get_boolean_value("bool-on", False) is True


def test_capabilities_advertise_control_points_and_remote(client):
    features = client.capabilities.get()["static"]["features"]
    assert features["controlPoints"] is True
    assert features["flags"] is True
    assert features["remoteAdapter"] is True


def test_flags_alias_silent_by_default(client, monkeypatch):
    monkeypatch.delenv("FW_DEPRECATION_WARNINGS", raising=False)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        _ = client.flags
    assert not any(issubclass(w.category, DeprecationWarning) for w in caught)


def test_flags_alias_warns_once_when_opted_in(simple_flags, monkeypatch):
    monkeypatch.setenv("FW_DEPRECATION_WARNINGS", "1")
    # Reset module-level notice flag between tests.
    import fireweave.client as client_mod

    client_mod._deprecation_notice_emitted = False
    runtime = FireweaveRuntime(InMemoryAdapter(simple_flags))
    runtime.initialize()
    c = FireweaveClient(runtime)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        _ = c.flags
        _ = c.flags
    deprecations = [w for w in caught if issubclass(w.category, DeprecationWarning)]
    assert len(deprecations) == 1
    assert "control_points" in str(deprecations[0].message)
    c.shutdown()
