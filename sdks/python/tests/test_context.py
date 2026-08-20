"""Context bounds, reserved keys, merge order, and immutability
(spec/control-points.md "Validation, before any I/O" rule 3).

`validate_context` is a pure, total function (domain/validation.py): it
RETURNS a `Validated` rather than raising — these tests assert on
`result.ok`/`result.error`, not `pytest.raises`.
"""

from __future__ import annotations

import pytest

from fireweave import (
    ContextLimits,
    EvaluationContext,
    ErrorKind,
    InvalidContextError,
    TargetingKeyMissingError,
    merge_contexts,
    validate_context,
)

LIMITS = ContextLimits()


def _validate(ctx: EvaluationContext, **kwargs):
    return validate_context(ctx, limits=LIMITS, **kwargs)


def _assert_invalid(ctx: EvaluationContext, match: str = "", **kwargs):
    result = _validate(ctx, **kwargs)
    assert not result.ok
    assert isinstance(result.error, InvalidContextError)
    if match:
        assert match in result.error.message
    return result


class TestBounds:
    def test_attribute_count_cap(self):
        ok = EvaluationContext("u", {f"a{i}": i for i in range(128)})
        assert _validate(ok).ok
        _assert_invalid(
            EvaluationContext("u", {f"a{i}": i for i in range(129)}), "attribute count"
        )

    def test_key_size_cap(self):
        assert _validate(EvaluationContext("u", {"k" * 256: 1})).ok
        _assert_invalid(EvaluationContext("u", {"k" * 257: 1}), "key exceeds")

    def test_key_size_counts_bytes_not_chars(self):
        # 100 three-byte chars = 300 bytes > 256.
        _assert_invalid(EvaluationContext("u", {"€" * 100: 1}), "key exceeds")

    def test_nested_key_size_checked(self):
        _assert_invalid(EvaluationContext("u", {"outer": {"k" * 257: 1}}), "key exceeds")

    def test_value_size_cap(self):
        assert _validate(EvaluationContext("u", {"blob": "B" * 4096})).ok
        _assert_invalid(EvaluationContext("u", {"blob": "B" * 4097}), "value exceeds")

    def test_nesting_depth_cap(self):
        # attributes root counts as depth 1; total depth 6 is allowed.
        deep: dict = {"leaf": True}
        for _ in range(4):
            deep = {"d": deep}
        assert _validate(EvaluationContext("u", {"root": deep})).ok  # depth 6 ok
        _assert_invalid(EvaluationContext("u", {"root": {"d": deep}}), "nesting depth")  # depth 7

    def test_serialized_size_cap(self):
        big = {f"p{i:02d}": "X" * 1700 for i in range(40)}
        _assert_invalid(EvaluationContext("u", big), "serialized context")

    def test_nulls_and_lists_within_bounds_accepted(self):
        assert _validate(
            EvaluationContext(
                "u", {"labels": ["a", "b"], "meta": {"child": {"ok": True}}, "opt": None}
            )
        ).ok


class TestReservedKeys:
    def test_targeting_key_attribute_rejected(self):
        _assert_invalid(EvaluationContext("u", {"targetingKey": "dup"}))

    def test_kind_attribute_rejected(self):
        _assert_invalid(EvaluationContext("u", {"kind": "user"}))

    def test_unknown_fireweave_namespaced_key_rejected(self):
        _assert_invalid(EvaluationContext("u", {"fireweave.secret": 1}))

    def test_sanctioned_fireweave_carriers_allowed(self):
        assert _validate(
            EvaluationContext(
                "u",
                {
                    "fireweave.groups": {"organization": "org_1"},
                    "fireweave.groupProperties": {"organization": {"plan": "pro"}},
                },
            )
        ).ok

    def test_evaluation_contexts_key_rejected(self):
        """Only fireweave.groups + fireweave.groupProperties are sanctioned."""
        _assert_invalid(EvaluationContext("u", {"fireweave.evaluationContexts": ["prod"]}))

    def test_require_targeting_key(self):
        result = _validate(EvaluationContext(None, {"plan": "pro"}), require_targeting_key=True)
        assert not result.ok
        assert isinstance(result.error, TargetingKeyMissingError)
        assert result.error.openfeature_error_code == "TARGETING_KEY_MISSING"
        assert result.error.kind is ErrorKind.INVALID_CONTEXT


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


class TestCyclicContext:
    """Python containers can be cyclic too — construction (and therefore
    every read path) must never crash on one (spec/control-points.md
    "Return discipline — never throw into a read path")."""

    def test_self_referential_dict_does_not_crash_construction(self):
        cyclic: dict = {}
        cyclic["self"] = cyclic
        ctx = EvaluationContext("u", {"loop": cyclic, "plan": "pro"})
        # The cyclic branch is broken (replaced with None) rather than
        # recursed into forever; sibling data survives untouched.
        assert ctx.attributes["plan"] == "pro"
        assert ctx.attributes["loop"]["self"] is None

    def test_self_referential_list_does_not_crash_construction(self):
        cyclic: list = []
        cyclic.append(cyclic)
        ctx = EvaluationContext("u", {"loop": cyclic})
        assert ctx.attributes["loop"][0] is None

    def test_shared_non_cyclic_reference_is_not_treated_as_a_cycle(self):
        shared = {"x": 1}
        ctx = EvaluationContext("u", {"a": shared, "b": shared})
        assert ctx.attributes["a"] == {"x": 1}
        assert ctx.attributes["b"] == {"x": 1}

    def test_cyclic_context_reaches_validate_context_without_raising(self):
        cyclic: dict = {}
        cyclic["self"] = cyclic
        ctx = EvaluationContext("u", {"loop": cyclic})
        result = _validate(ctx)
        assert result.ok  # cycle already broken at construction; nothing left to reject
