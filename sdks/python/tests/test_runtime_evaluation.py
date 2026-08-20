"""Runtime evaluation pipeline: typing rules, reasons, metadata."""

from __future__ import annotations

from fireweave import (
    ErrorKind,
    EvaluationContext,
    FireweaveRuntime,
    FlagType,
    InMemoryAdapter,
)

CTX = EvaluationContext("u")


def make_runtime(flags) -> FireweaveRuntime:
    runtime = FireweaveRuntime(InMemoryAdapter(flags))
    runtime.initialize()
    return runtime


class TestTypeRules:
    def test_number_accepts_int(self):
        rt = make_runtime({"n": {"enabled": True, "value": 50}})
        d = rt.evaluate("n", FlagType.NUMBER, 0, CTX)
        assert d.value == 50 and isinstance(d.value, int)

    def test_number_accepts_float(self):
        rt = make_runtime({"n": {"enabled": True, "value": 2.5}})
        d = rt.evaluate("n", FlagType.NUMBER, 0.0, CTX)
        assert d.value == 2.5 and isinstance(d.value, float)

    def test_bool_not_accepted_as_number(self):
        rt = make_runtime({"b": {"enabled": True, "value": True}})
        d = rt.evaluate("b", FlagType.NUMBER, 7, CTX)
        assert d.value == 7 and d.error_kind is ErrorKind.TYPE_MISMATCH

    def test_string_not_accepted_as_number(self):
        rt = make_runtime({"s": {"enabled": True, "value": "50"}})
        d = rt.evaluate("s", FlagType.NUMBER, 0, CTX)
        assert d.value == 0 and d.error_kind is ErrorKind.TYPE_MISMATCH

    def test_big_int_beyond_2_53_preserved(self):
        rt = make_runtime({"big": {"enabled": True, "value": 9007199254740993}})
        d = rt.evaluate("big", FlagType.NUMBER, 0, CTX)
        assert d.value == 9007199254740993  # Python ints are exact

    def test_object_accepts_dict_and_list(self):
        rt = make_runtime(
            {
                "obj": {"enabled": True, "value": {"a": 1}},
                "arr": {"enabled": True, "value": [1, 2]},
            }
        )
        assert rt.evaluate("obj", FlagType.OBJECT, {}, CTX).value == {"a": 1}
        assert rt.evaluate("arr", FlagType.OBJECT, [], CTX).value == [1, 2]

    def test_default_type_mismatch_is_rejected_before_any_io(self):
        rt = make_runtime({})
        d = rt.evaluate("whatever", FlagType.BOOLEAN, "not-a-bool", CTX)
        assert d.value == "not-a-bool" and d.error_kind is ErrorKind.TYPE_MISMATCH


class TestReasonsAndMetadata:
    def test_split_reason_override(self):
        rt = make_runtime(
            {"s": {"enabled": True, "variant": "on", "value": True, "fireweaveReason": "SPLIT"}}
        )
        assert rt.evaluate("s", FlagType.BOOLEAN, False, CTX).reason == "SPLIT"

    def test_disabled_returns_flag_value_with_disabled_reason(self):
        rt = make_runtime({"d": {"enabled": False, "variant": "off", "value": False}})
        d = rt.evaluate("d", FlagType.BOOLEAN, True, CTX)
        assert d.value is False and d.variant == "off" and d.reason == "DISABLED"

    def test_unmatched_conditions_yield_default_reason(self):
        rt = make_runtime(
            {"m": {"enabled": True, "variant": "on", "value": True, "matchAttribute": {"tier": "gold"}}}
        )
        d = rt.evaluate("m", FlagType.BOOLEAN, False, EvaluationContext("u", {"tier": "bronze"}))
        assert d.value is False and d.reason == "DEFAULT" and d.error_code is None

    def test_key_genuinely_absent_is_error_flag_not_found(self):
        rt = make_runtime({})
        d = rt.evaluate("missing", FlagType.BOOLEAN, False, CTX)
        assert d.value is False and d.error_kind is ErrorKind.FLAG_NOT_FOUND
        assert d.flag_metadata == {"fireweave.errorKind": "FlagNotFound"}

    def test_vendor_metadata_gated_on_id_and_condition_index_and_reason_code(self):
        rt = make_runtime(
            {
                "with_meta": {
                    "enabled": True,
                    "value": True,
                    "metadata": {"id": 42, "version": 3},
                    "reason": {"code": "condition_match", "condition_index": 0},
                }
            }
        )
        d = rt.evaluate("with_meta", FlagType.BOOLEAN, False, CTX)
        assert d.flag_metadata["fireweave.vendorFlagId"] == 42
        assert d.flag_metadata["fireweave.reasonCode"] == "condition_match"
        assert d.flag_metadata["fireweave.flagVersion"] == 3


class TestContextLayering:
    """Merge order: global -> client -> invocation, later layers winning per
    attribute key (spec/control-points.md "Context")."""

    def test_global_then_client_then_invocation_later_wins(self):
        rt = make_runtime(
            {"m": {"enabled": True, "value": True, "matchAttribute": {"tier": "gold"}}}
        )
        rt.set_global_context(EvaluationContext("u", {"tier": "bronze"}))
        rt.set_client_context(EvaluationContext(None, {"tier": "silver"}))
        # invocation context omitted -> client layer's "silver" should still lose
        assert rt.evaluate("m", FlagType.BOOLEAN, False).reason == "DEFAULT"
        # invocation context overrides both -> matches
        d = rt.evaluate("m", FlagType.BOOLEAN, False, EvaluationContext(None, {"tier": "gold"}))
        assert d.value is True and d.reason == "TARGETING_MATCH"

    def test_targeting_key_survives_from_global_when_invocation_omits_it(self):
        rt = make_runtime({"f": {"enabled": True, "value": True, "matchTargetingKey": "u1"}})
        rt.set_global_context(EvaluationContext("u1"))
        d = rt.evaluate("f", FlagType.BOOLEAN, False)
        assert d.value is True
