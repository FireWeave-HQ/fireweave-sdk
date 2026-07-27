"""Context bounds, reserved keys, merge order, and immutability."""

from __future__ import annotations

import pytest

from fireweave import (
    ContextLimits,
    EvaluationContext,
    InvalidContextError,
    TargetingKeyMissingError,
    merge_contexts,
    validate_context,
)

LIMITS = ContextLimits()


def _validate(ctx: EvaluationContext, **kwargs):
    validate_context(ctx, limits=LIMITS, **kwargs)


class TestBounds:
    def test_attribute_count_cap(self):
        ok = EvaluationContext("u", {f"a{i}": i for i in range(128)})
        _validate(ok)
        with pytest.raises(InvalidContextError, match="attribute count"):
            _validate(EvaluationContext("u", {f"a{i}": i for i in range(129)}))

    def test_key_size_cap(self):
        _validate(EvaluationContext("u", {"k" * 256: 1}))
        with pytest.raises(InvalidContextError, match="key exceeds"):
            _validate(EvaluationContext("u", {"k" * 257: 1}))

    def test_key_size_counts_bytes_not_chars(self):
        # 100 three-byte chars = 300 bytes > 256.
        with pytest.raises(InvalidContextError, match="key exceeds"):
            _validate(EvaluationContext("u", {"\u20ac" * 100: 1}))

    def test_nested_key_size_checked(self):
        with pytest.raises(InvalidContextError, match="key exceeds"):
            _validate(EvaluationContext("u", {"outer": {"k" * 257: 1}}))

    def test_value_size_cap(self):
        _validate(EvaluationContext("u", {"blob": "B" * 4096}))
        with pytest.raises(InvalidContextError, match="value exceeds"):
            _validate(EvaluationContext("u", {"blob": "B" * 4097}))

    def test_nesting_depth_cap(self):
        # attributes root counts as depth 1; total depth 6 is allowed.
        deep: dict = {"leaf": True}
        for _ in range(4):
            deep = {"d": deep}
        _validate(EvaluationContext("u", {"root": deep}))  # depth 6 ok
        with pytest.raises(InvalidContextError, match="nesting depth"):
            _validate(EvaluationContext("u", {"root": {"d": deep}}))  # depth 7

    def test_serialized_size_cap(self):
        big = {f"p{i:02d}": "X" * 1700 for i in range(40)}
        with pytest.raises(InvalidContextError, match="serialized context"):
            _validate(EvaluationContext("u", big))

    def test_nulls_and_lists_within_bounds_accepted(self):
        _validate(
            EvaluationContext(
                "u", {"labels": ["a", "b"], "meta": {"child": {"ok": True}}, "opt": None}
            )
        )


class TestReservedKeys:
    def test_targeting_key_attribute_rejected(self):
        with pytest.raises(InvalidContextError):
            _validate(EvaluationContext("u", {"targetingKey": "dup"}))

    def test_kind_attribute_rejected(self):
        with pytest.raises(InvalidContextError):
            _validate(EvaluationContext("u", {"kind": "user"}))

    def test_unknown_fireweave_namespaced_key_rejected(self):
        with pytest.raises(InvalidContextError):
            _validate(EvaluationContext("u", {"fireweave.secret": 1}))

    def test_sanctioned_fireweave_carriers_allowed(self):
        _validate(
            EvaluationContext(
                "u",
                {
                    "fireweave.groups": {"organization": "org_1"},
                    "fireweave.groupProperties": {"organization": {"plan": "pro"}},
                },
            )
        )

    def test_require_targeting_key(self):
        with pytest.raises(TargetingKeyMissingError) as exc_info:
            _validate(EvaluationContext(None, {"plan": "pro"}), require_targeting_key=True)
        assert exc_info.value.openfeature_error_code == "TARGETING_KEY_MISSING"


class TestMergeAndImmutability:
    def test_merge_order_later_layers_win(self):
        merged = merge_contexts(
            EvaluationContext("org_1", {"tier": "bronze", "region": "us"}),
            EvaluationContext(None, {"tier": "silver"}),
            EvaluationContext(None, {"tier": "gold"}),
        )
        assert merged.targeting_key == "org_1"
        assert dict(merged.attributes) == {"tier": "gold", "region": "us"}

    def test_merge_targeting_key_latest_wins(self):
        merged = merge_contexts(
            EvaluationContext("global"), None, EvaluationContext("invocation")
        )
        assert merged.targeting_key == "invocation"

    def test_caller_dict_mutation_does_not_leak(self):
        source = {"nested": {"a": 1}}
        ctx = EvaluationContext("u", source)
        source["nested"]["a"] = 999
        assert ctx.attributes["nested"]["a"] == 1

    def test_attributes_view_is_read_only(self):
        ctx = EvaluationContext("u", {"a": 1})
        with pytest.raises(TypeError):
            ctx.attributes["a"] = 2  # type: ignore[index]

    def test_frozen_dataclass(self):
        ctx = EvaluationContext("u")
        with pytest.raises(AttributeError):
            ctx.targeting_key = "other"  # type: ignore[misc]

    def test_groups_from_plain_and_namespaced_keys(self):
        plain = EvaluationContext("u", {"groups": {"org": "o1"}})
        namespaced = EvaluationContext("u", {"fireweave.groups": {"org": "o2"}})
        assert plain.groups == {"org": "o1"}
        assert namespaced.groups == {"org": "o2"}

    def test_vendor_hints_split_out(self):
        ctx = EvaluationContext("u", {"$process_person_profile": False, "plan": "pro"})
        assert ctx.vendor_hints == {"$process_person_profile": False}
        assert ctx.plain_attributes == {"plan": "pro"}
