"""Core input guards (F6): the wrong shape at the core boundary degrades to an
InvalidContext decision or an ``ok=False`` result, never an exception out of a
read or out of register_target."""

from __future__ import annotations

import datetime

import pytest

from fireweave import (
    ErrorKind,
    EvaluationContext,
    FlagType,
    RegisterTargetOptions,
    init_fireweave,
)

CTX = EvaluationContext("user-1")


def _remote(calls):
    def transport(url, body, headers, timeout):
        calls.append(body)
        if url.endswith("/v1/targets/register"):
            return 200, {"ok": True}
        return 200, {"decisions": [{"flagKey": k, "value": True, "found": True} for k in body["flagKeys"]]}

    return init_fireweave(
        mode="remote", api_key="project-api-key_guards", api_url="http://127.0.0.1:1", transport=transport
    )


def _local():
    return init_fireweave(mode="local", local={"control_points": {"x": True}, "log": lambda line: None})


@pytest.fixture(params=["remote", "local"])
def client_and_calls(request):
    calls = []
    client = _remote(calls) if request.param == "remote" else _local()
    yield client, calls
    client.shutdown()


READS = [
    ("get_boolean_value", False, False),
    ("get_string_value", "d", False),
    ("get_number_value", 3, False),
    ("get_object_value", {"a": 1}, False),
    ("get_boolean_details", False, True),
    ("get_string_details", "d", True),
    ("get_number_details", 3, True),
    ("get_object_details", {"a": 1}, True),
]

BAD_CONTEXTS = [
    pytest.param({"targeting_key": "u"}, id="dict"),
    pytest.param("user-1", id="str"),
    pytest.param(EvaluationContext(123), id="int-targeting-key"),  # type: ignore[arg-type]
    pytest.param(EvaluationContext(b"user-1"), id="bytes-targeting-key"),  # type: ignore[arg-type]
    pytest.param(EvaluationContext("u", {1: "x"}), id="int-attribute-name"),  # type: ignore[dict-item]
    pytest.param(EvaluationContext("u", {"nested": {2: "x"}}), id="nested-int-name"),  # type: ignore[dict-item]
]


@pytest.mark.parametrize("context", BAD_CONTEXTS)
@pytest.mark.parametrize(("method", "default", "details"), READS, ids=[r[0] for r in READS])
def test_a_bad_context_is_invalid_context_on_every_read(client_and_calls, method, default, details, context):
    client, calls = client_and_calls
    result = getattr(client.control_points, method)("x", default, context)
    if details:
        assert (result.value, result.reason, result.error_kind) == (default, "ERROR", ErrorKind.INVALID_CONTEXT)
        assert result.flag_metadata == {"fireweave.errorKind": "InvalidContext"}
    else:
        assert result == default
    assert calls == []  # nothing reached the backend


@pytest.mark.parametrize("context", BAD_CONTEXTS)
def test_a_bad_context_is_invalid_context_on_evaluate(client_and_calls, context):
    client, calls = client_and_calls
    decision = client.control_points.evaluate("x", FlagType.BOOLEAN, False, context)
    assert decision.error_kind is ErrorKind.INVALID_CONTEXT and calls == []


def test_a_bad_client_context_layer_degrades_too(client_and_calls):
    client, _ = client_and_calls
    client.set_context({"targeting_key": "u"})  # type: ignore[arg-type]
    assert client.control_points.get_boolean_details("x", False, CTX).error_kind is ErrorKind.INVALID_CONTEXT


class _Opaque:
    pass


BAD_REGISTRATIONS = [
    pytest.param(123, None, id="int-targeting-key"),
    pytest.param(None, None, id="none-targeting-key"),
    pytest.param("u", RegisterTargetOptions(properties={"at": datetime.date(2026, 1, 1)}), id="date-value"),
    pytest.param("u", RegisterTargetOptions(properties={"tags": {"a", "b"}}), id="set-value"),
    pytest.param("u", RegisterTargetOptions(properties={"o": _Opaque()}), id="object-value"),
    pytest.param("u", RegisterTargetOptions(properties={"n": float("nan")}), id="nan-value"),
    pytest.param("u", RegisterTargetOptions(properties={1: "x"}), id="int-property-name"),  # type: ignore[dict-item]
    pytest.param("u", RegisterTargetOptions(properties=["plan", "pro"]), id="list-properties"),  # type: ignore[arg-type]
    pytest.param("u", {"properties": {"plan": "pro"}}, id="dict-options"),
]


@pytest.mark.parametrize(("targeting_key", "options"), BAD_REGISTRATIONS)
def test_register_target_with_bad_input_is_ok_false_invalid_context(client_and_calls, targeting_key, options):
    client, calls = client_and_calls
    result = client.register_target(targeting_key, options)
    assert result.ok is False and result.error.kind is ErrorKind.INVALID_CONTEXT
    assert calls == []


def test_a_cyclic_property_is_ok_false_invalid_context(client_and_calls):
    client, calls = client_and_calls
    cyclic = {}
    cyclic["self"] = cyclic
    result = client.register_target("u", RegisterTargetOptions(properties={"c": cyclic}))
    assert result.ok is False and result.error.kind is ErrorKind.INVALID_CONTEXT and calls == []


def test_good_input_still_registers(client_and_calls):
    client, calls = client_and_calls
    assert client.register_target("u", RegisterTargetOptions(properties={"plan": "pro", "seats": 3})).ok is True


@pytest.mark.usefixtures("start_profile")
@pytest.mark.parametrize(
    ("targeting_key", "properties"),
    [
        pytest.param(123, None, id="int-targeting-key"),
        pytest.param("u", {"at": datetime.date(2026, 1, 1)}, id="date-value"),
        pytest.param("u", {"tags": {"a"}}, id="set-value"),
        pytest.param("u", ["plan", "pro"], id="list-properties"),
    ],
)
def test_fw_identify_with_bad_input_is_ok_false_invalid_context(targeting_key, properties):
    from fireweave.start import fw, start

    calls = []

    def transport(url, body, headers, timeout):
        calls.append(body)
        return 200, {"ok": True}

    start(key="project-api-key_guards", url="https://fw.example.com", env={}, transport=transport)
    result = fw.identify(targeting_key, properties)  # type: ignore[arg-type]
    assert result.ok is False and result.error.kind is ErrorKind.INVALID_CONTEXT
    assert calls == []
