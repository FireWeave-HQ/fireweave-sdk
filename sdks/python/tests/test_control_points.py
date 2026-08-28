"""control_points vocabulary + deprecated aliases (spec/control-points.md)."""

from __future__ import annotations

import warnings

from fireweave import FireweaveClient, FireweaveRuntime, InMemoryAdapter


def test_control_points_is_flags_alias(client):
    assert client.flags is client.control_points
    assert client.control_points.get_boolean_value("bool-on", False) is True


def test_flags_alias_warns_once_unconditionally():
    """Unconditional (no env gate): the SDK reads no environment variables
    (spec/modes.md "The SDK reads no environment variables", unscoped)."""
    runtime = FireweaveRuntime(InMemoryAdapter({}))
    runtime.initialize()
    c = FireweaveClient(runtime)
    import fireweave.application.client as client_mod

    client_mod._flags_alias_warned = False
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        _ = c.flags
        _ = c.flags
    deprecations = [w for w in caught if issubclass(w.category, DeprecationWarning)]
    assert len(deprecations) == 1
    assert "control_points" in str(deprecations[0].message)
    c.shutdown()


def test_get_integer_value_delegates_and_warns_once(client):
    import fireweave.application.client as client_mod

    client_mod._get_integer_value_warned = False
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        value = client.control_points.get_integer_value("bool-on", 0)
        value_again = client.control_points.get_integer_value("bool-on", 0)
    deprecations = [w for w in caught if issubclass(w.category, DeprecationWarning)]
    assert len(deprecations) == 1
    assert "get_number_value" in str(deprecations[0].message)
    # bool-on is boolean; get_integer_value delegates straight to
    # get_number_value, so a boolean value here degrades to the default via
    # TypeMismatch — proving delegation, not a parallel code path.
    assert value == value_again == 0
