"""Runtime evaluation pipeline: typing rules, reasons, metadata, payloads."""

from __future__ import annotations

from fireweave import (
    EvaluationContext,
    EvaluationOptions,
    FireweaveRuntime,
    FlagType,
    InMemoryAdapter,
)
from fireweave.errors import ErrorKind

CTX = EvaluationContext("u")


def make_runtime(flags) -> FireweaveRuntime:
    runtime = FireweaveRuntime(InMemoryAdapter(flags))
    runtime.initialize()
    return runtime


class TestTypeRules:
    def test_int_coerces_to_float(self):
        rt = make_runtime({"n": {"type": "integer", "enabled": True, "value": 50}})
        d = rt.evaluate("n", FlagType.FLOAT, 0.0, CTX)
        assert d.value == 50.0 and isinstance(d.value, float)

    def test_integral_float_rejected_as_integer(self):
        rt = make_runtime({"n": {"type": "float", "enabled": True, "value": 2.0}})
        d = rt.evaluate("n", FlagType.INTEGER, 0, CTX)
        assert d.value == 0 and d.error_kind is ErrorKind.TYPE_MISMATCH

    def test_bool_not_accepted_as_integer(self):
        rt = make_runtime({"b": {"type": "boolean", "enabled": True, "value": True}})
        d = rt.evaluate("b", FlagType.INTEGER, 7, CTX)
        assert d.value == 7 and d.error_kind is ErrorKind.TYPE_MISMATCH

    def test_big_int_beyond_2_53_preserved(self):
        rt = make_runtime(
            {"big": {"type": "integer", "enabled": True, "value": 9007199254740993}}
        )
        d = rt.evaluate("big", FlagType.INTEGER, 0, CTX)
        assert d.value == 9007199254740993  # Python ints are exact


class TestReasonsAndMetadata:
    def test_split_reason_override(self):
        rt = make_runtime(
            {"s": {"type": "boolean", "enabled": True, "variant": "on",
                   "value": True, "fireweaveReason": "SPLIT"}}
        )
        assert rt.evaluate("s", FlagType.BOOLEAN, False, CTX).reason == "SPLIT"

    def test_disabled_returns_flag_value_with_disabled_reason(self):
        rt = make_runtime(
            {"d": {"type": "boolean", "enabled": False, "variant": "off",
                   "value": False}}
        )
        d = rt.evaluate("d", FlagType.BOOLEAN, True, CTX)
        assert d.value is False and d.variant == "off" and d.reason == "DISABLED"

    def test_payload_metadata_sorted_json(self):
        rt = make_runtime(
            {"p": {"type": "boolean", "enabled": True, "variant": "on",
                   "value": True, "payload": {"b": 2, "a": 1}}}
        )
        d = rt.evaluate("p", FlagType.BOOLEAN, False, CTX,
                        EvaluationOptions(include_payload=True))
        assert d.flag_metadata["fireweave.payload"] == '{"a":1,"b":2}'
        # Without the option, payload is not attached.
        d2 = rt.evaluate("p", FlagType.BOOLEAN, False, CTX)
        assert "fireweave.payload" not in d2.flag_metadata

    def test_unmatched_conditions_yield_default_reason(self):
        rt = make_runtime(
            {"m": {"type": "boolean", "enabled": True, "variant": "on",
                   "value": True, "matchAttribute": {"tier": "gold"}}}
        )
        d = rt.evaluate("m", FlagType.BOOLEAN, False,
                        EvaluationContext("u", {"tier": "bronze"}))
        assert d.value is False and d.reason == "DEFAULT" and d.error_code is None

    def test_error_decision_carries_error_kind_metadata(self):
        rt = make_runtime({})
        d = rt.evaluate("missing", FlagType.BOOLEAN, False, CTX)
        assert d.flag_metadata == {"fireweave.errorKind": "FlagNotFound"}
