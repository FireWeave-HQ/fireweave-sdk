"""Evaluation-context value type: merge order (global -> client -> invocation)
and immutable canonicalization of raw caller input.

Bounds are enforced in :mod:`fireweave.domain.validation` (`validate_context`) —
spec/control-points.md "Validation, before any I/O" rule 3. This module has no
raising/failing surface of its own: constructing an :class:`EvaluationContext`
never raises, even for a cyclic ``attributes`` mapping (Python containers can
be cyclic; a naive recursive deep copy would blow the stack, which is exactly
the kind of crash a "before any I/O" pipeline must not allow —
spec/control-points.md "Return discipline"). :func:`_deep_copy_json` is
cycle-safe: a true back-reference to an ancestor is broken (replaced with
``None``) rather than recursed into, while a value legitimately shared by two
sibling branches (not a cycle) is still copied correctly via backtracking.

Construction not crashing is NOT the same claim as a cyclic context being
VALID. node/web detect the cycle inside `validateContext` (against raw,
not-yet-copied input) and fail CLOSED with `InvalidContextError('context
contains a circular reference')`. Python's `EvaluationContext` copies eagerly
at construction — by design, independent of validation, and covered by its
own immutability tests — so there is no single later point that sees the raw
input. Instead, `__post_init__` records whether its own copy broke a cycle on
a private `_had_cyclic_input` flag, and :func:`merge_contexts` propagates
that flag from every layer it merges (a layer's cycle was already resolved to
``None`` by the time it reaches `merge_contexts`, so the flag is the only
surviving evidence). `domain.validation.validate_context` checks the flag
FIRST, before any other rule, and fails closed exactly like node/web.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Dict, Mapping, Optional

from .types import JsonValue

__all__ = [
    "ContextLimits",
    "DEFAULT_CONTEXT_LIMITS",
    "DEFAULT_RESERVED_ATTRIBUTE_KEYS",
    "ALLOWED_FIREWEAVE_CONTEXT_KEYS",
    "EvaluationContext",
    "merge_contexts",
]

# Sanctioned fireweave.* carriers (spec/evaluation-context.schema.json): the
# ONLY `fireweave.*` context keys callers may set. Canonical spelling for
# group memberships / group properties; plain `groups`/`groupProperties`
# remain accepted as a documented alias.
ALLOWED_FIREWEAVE_CONTEXT_KEYS = frozenset({"fireweave.groups", "fireweave.groupProperties"})

DEFAULT_RESERVED_ATTRIBUTE_KEYS: tuple = ("targetingKey", "kind")


@dataclass(frozen=True)
class ContextLimits:
    """Context bounds (spec/evaluation-context.schema.json)."""

    max_attribute_count: int = 128
    max_key_bytes: int = 256
    max_value_bytes: int = 4096
    max_nesting_depth: int = 6
    max_serialized_bytes: int = 65536


DEFAULT_CONTEXT_LIMITS = ContextLimits()


def _deep_copy_json(value: Any, seen: Optional[set] = None, cycle_flag: Optional[list] = None) -> Any:
    """Cycle-safe structural copy. A dict/list already on the current
    recursion path (a genuine cycle, not merely shared by two siblings) is
    replaced with ``None`` instead of recursed into — see the module
    docstring.

    ``cycle_flag``, when passed, is a one-element mutable box
    (``[False]``); it is set to ``True`` the moment a cycle is detected, so
    the caller can tell "a branch was truncated" apart from "this data
    legitimately contains ``None``" without re-walking the result.
    """
    if seen is None:
        seen = set()
    if isinstance(value, dict):
        marker = id(value)
        if marker in seen:
            if cycle_flag is not None:
                cycle_flag[0] = True
            return None
        seen.add(marker)
        try:
            return {k: _deep_copy_json(v, seen, cycle_flag) for k, v in value.items()}
        finally:
            seen.discard(marker)
    if isinstance(value, list):
        marker = id(value)
        if marker in seen:
            if cycle_flag is not None:
                cycle_flag[0] = True
            return None
        seen.add(marker)
        try:
            return [_deep_copy_json(v, seen, cycle_flag) for v in value]
        finally:
            seen.discard(marker)
    return value


@dataclass(frozen=True)
class EvaluationContext:
    """Immutable Fireweave evaluation context layer.

    ``attributes`` are deep-copied at construction so later mutation of the
    caller's dict cannot leak in, and are exposed through a read-only mapping.
    """

    targeting_key: Optional[str] = None
    attributes: Mapping[str, JsonValue] = field(default_factory=dict)

    def __post_init__(self) -> None:
        cycle_flag = [False]
        copied = _deep_copy_json(dict(self.attributes), cycle_flag=cycle_flag)
        object.__setattr__(self, "attributes", MappingProxyType(copied))
        # Private, not a dataclass field (deliberately excluded from
        # __init__/__eq__/__repr__): whether THIS construction's copy had to
        # break a cycle. `domain.validation.validate_context` reads it to
        # fail closed. See the module docstring for why this lives here
        # rather than at validation time.
        object.__setattr__(self, "_had_cyclic_input", cycle_flag[0])

    def to_dict(self) -> Dict[str, Any]:
        """Plain-dict snapshot (deep copy) of this context."""
        out: Dict[str, Any] = {}
        if self.targeting_key is not None:
            out["targetingKey"] = self.targeting_key
        if self.attributes:
            out["attributes"] = _deep_copy_json(dict(self.attributes))
        return out

    @property
    def vendor_hints(self) -> Dict[str, JsonValue]:
        """``$``-prefixed attributes: vendor pass-through options."""
        return {k: v for k, v in self.attributes.items() if k.startswith("$")}

    @property
    def plain_attributes(self) -> Dict[str, JsonValue]:
        """Attributes minus vendor hints (``$``-prefixed keys)."""
        return {
            k: _deep_copy_json(v)
            for k, v in self.attributes.items()
            if not k.startswith("$")
        }

    @property
    def groups(self) -> Dict[str, str]:
        """Group memberships from ``fireweave.groups`` or plain ``groups``."""
        raw = self.attributes.get("fireweave.groups", self.attributes.get("groups"))
        return dict(raw) if isinstance(raw, dict) else {}

    @property
    def group_properties(self) -> Dict[str, Any]:
        raw = self.attributes.get(
            "fireweave.groupProperties", self.attributes.get("groupProperties")
        )
        return _deep_copy_json(raw) if isinstance(raw, dict) else {}


def merge_contexts(*layers: Optional[EvaluationContext]) -> EvaluationContext:
    """Merge context layers; later layers win per attribute key.

    Order: global -> client -> invocation (spec/control-points.md "Context").
    ``targeting_key`` from the latest layer that sets one wins. Merge is
    shallow per top-level attribute key.

    Propagates ``_had_cyclic_input``: by the time a layer reaches this
    function its own cycle (if any) has already been broken to ``None`` by
    its own construction, so the flag is the only surviving evidence that it
    happened. Without this propagation, `FireweaveRuntime.evaluate` (which
    always merges global/client/invocation layers before validating) would
    never see a cyclic invocation context as cyclic — the merged result's
    OWN copy would run on already-clean data and see no cycle of its own.
    """
    targeting_key: Optional[str] = None
    attributes: Dict[str, JsonValue] = {}
    had_cyclic_input = False
    for layer in layers:
        if layer is None:
            continue
        if layer.targeting_key is not None:
            targeting_key = layer.targeting_key
        attributes.update(dict(layer.attributes))
        if getattr(layer, "_had_cyclic_input", False):
            had_cyclic_input = True
    merged = EvaluationContext(targeting_key=targeting_key, attributes=attributes)
    if had_cyclic_input:
        object.__setattr__(merged, "_had_cyclic_input", True)
    return merged
