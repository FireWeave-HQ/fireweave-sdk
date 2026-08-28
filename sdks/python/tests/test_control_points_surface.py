"""Control-point SURFACE parity (spec/control-points.md, conformance/surface/).

Behaviour is asserted elsewhere; this file asserts the surface EXISTS. That
distinction matters because a missing method is invisible: go shipped
`client.Flags()` with no ControlPoints namespace, and python shipped
`get_integer_value` with no object variant, both unnoticed for months,
because nothing structurally forced seven independent implementations to
agree. A parity fixture turns silent divergence into a failing assertion.

Also pins the v1 scope boundary — the namespaces and the OpenFeature provider
that must NOT come back (conformance/surface/control-points.surface.json
"mustNotExpose").
"""

from __future__ import annotations

import inspect
import json
from pathlib import Path

import pytest

from fireweave import FireweaveClient, FireweaveRuntime, InMemoryAdapter

HERE = Path(__file__).resolve().parent
SURFACE_DESCRIPTOR_PATH = HERE.parents[2] / "conformance" / "surface" / "control-points.surface.json"

with SURFACE_DESCRIPTOR_PATH.open() as fh:
    DESCRIPTOR = json.load(fh)

# snake_case mapping of the descriptor's camelCase method names — the
# descriptor is language-neutral; python's idiom is snake_case
# (conformance/surface/control-points.surface.json header comment: "note
# python casing: control_points, snake_case methods").
_CAMEL_TO_SNAKE = {
    "getBooleanValue": "get_boolean_value",
    "getStringValue": "get_string_value",
    "getNumberValue": "get_number_value",
    "getObjectValue": "get_object_value",
    "getBooleanDetails": "get_boolean_details",
    "getStringDetails": "get_string_details",
    "getNumberDetails": "get_number_details",
    "getObjectDetails": "get_object_details",
    "evaluate": "evaluate",
}

REQUIRED_METHODS = tuple(_CAMEL_TO_SNAKE.values())


def client() -> FireweaveClient:
    return FireweaveClient(FireweaveRuntime(InMemoryAdapter({})))


def test_control_points_exposes_all_nine_methods():
    cp = client().control_points
    missing = [m for m in REQUIRED_METHODS if not callable(getattr(cp, m, None))]
    assert missing == [], f"missing control-point methods: {', '.join(missing)}"


def test_every_method_matches_the_descriptors_arity_exactly():
    """A method existing is not the same claim as a method matching the
    shape the descriptor pins — `evaluate` carries the general form's fifth
    `options?` parameter, the eight delegates carry exactly three. Reading
    `args` from the descriptor (rather than hard-coding counts here) makes
    this test track the descriptor instead of silently drifting from it.
    """
    cp = client().control_points
    assert len(DESCRIPTOR["methods"]) > 0, "expected methods in the surface descriptor"

    offenders = []
    for method in DESCRIPTOR["methods"]:
        snake_name = _CAMEL_TO_SNAKE.get(method["name"])
        assert snake_name is not None, f"no snake_case mapping for {method['name']!r}"
        fn = getattr(cp, snake_name, None)
        if not callable(fn):
            offenders.append(f"{snake_name}: missing")
            continue
        # Bound methods: `self` is already applied, so the remaining
        # positional/keyword parameter count IS the arity the descriptor
        # pins (`context`/`options` are optional but still counted params).
        params = [
            p
            for p in inspect.signature(fn).parameters.values()
            if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD, p.KEYWORD_ONLY)
        ]
        expected_arity = len(method["args"])
        if len(params) != expected_arity:
            offenders.append(
                f"{snake_name}: expected arity {expected_arity} ({', '.join(method['args'])}), got {len(params)}"
            )
    assert offenders == [], f"arity mismatches: {'; '.join(offenders)}"


def test_the_deprecated_flags_alias_shares_identity_with_control_points():
    fw = client()
    assert fw.flags is fw.control_points


def test_details_returns_a_decision_value_returns_the_bare_value():
    fw = client()
    value = fw.control_points.get_boolean_value("absent", False)
    details = fw.control_points.get_boolean_details("absent", False)

    assert value is False
    assert details.value is False
    # The whole point of the pair: details carries what value cannot.
    assert isinstance(details.reason, str)


@pytest.mark.parametrize("ns", ["releases", "exposures", "signals", "capabilities", "guardrails"])
def test_v1_scope_the_cut_namespaces_are_absent(ns):
    fw = client()
    assert not hasattr(fw, ns), f"{ns} must not be exposed in v1"


@pytest.mark.parametrize("symbol", ["FireweaveProvider", "FireweaveWebProvider", "make_fireweave_local_provider"])
def test_v1_scope_the_openfeature_provider_is_absent(symbol):
    import fireweave as fw_module

    assert not hasattr(fw_module, symbol), f"{symbol} was retired and must not return without superseding it"
    # And the module it used to live in is gone outright.
    assert not hasattr(fw_module, "openfeature")


def test_namespace_is_control_points_per_descriptor_casing():
    assert DESCRIPTOR["namespace"]["casing"]["python"] == "control_points"
    assert hasattr(client(), "control_points")


def test_deprecated_alias_matches_descriptor():
    assert DESCRIPTOR["namespace"]["deprecatedAlias"] == "flags"
    assert DESCRIPTOR["namespace"]["aliasMustShareIdentity"] is True


def test_register_target_exists_with_local_mode_recorded_and_traced():
    entry = next(m for m in DESCRIPTOR["client"]["methods"] if m["name"] == "registerTarget")
    assert entry["localMode"] == "recorded-and-traced"
    fw = client()
    assert callable(fw.register_target)
