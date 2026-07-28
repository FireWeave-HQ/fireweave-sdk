"""Canonical evaluation context: bounds, reserved keys, merge, immutability.

Implements ``spec/evaluation-context.schema.json`` v0.1.0:

- Bounds: 128 attributes, 256-byte keys, 4 KiB string values, nesting depth 6,
  64 KiB serialized size.
- Reserved keys: ``targetingKey`` / ``kind`` (configurable) may not appear in
  attributes; ``fireweave.*`` keys are reserved for the SDK except the
  sanctioned carriers (``fireweave.groups``, ``fireweave.groupProperties``
  — rulings 12–13: these are the ONLY permitted ``fireweave.*`` keys).
- Merge order: global -> client -> invocation (later layers win per key).
- Immutability: contexts are frozen; attribute maps are deep-copied on
  construction and exposed via read-only views.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Dict, Iterable, Mapping, Optional, Tuple

from .errors import InvalidContextError, TargetingKeyMissingError
from .types import JsonValue

__all__ = ["ContextLimits", "EvaluationContext", "merge_contexts", "validate_context"]

# Sanctioned fireweave.* carriers (spec/evaluation-context.schema.json,
# orchestrator rulings 12–13): exactly these two — nothing else.
_ALLOWED_FIREWEAVE_KEYS = frozenset(
    {"fireweave.groups", "fireweave.groupProperties"}
)
_DEFAULT_RESERVED_KEYS = ("targetingKey", "kind")


@dataclass(frozen=True)
class ContextLimits:
    """Ratified context bounds (contracts/README.md)."""

    max_attribute_count: int = 128
    max_key_bytes: int = 256
    max_value_bytes: int = 4096
    max_nesting_depth: int = 6
    max_serialized_bytes: int = 65536


def _deep_copy_json(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _deep_copy_json(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_deep_copy_json(v) for v in value]
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
        copied = _deep_copy_json(dict(self.attributes))
        object.__setattr__(self, "attributes", MappingProxyType(copied))

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

    Order: global -> client -> invocation. ``targeting_key`` from the latest
    layer that sets one wins. Merge is shallow per top-level attribute key.
    """
    targeting_key: Optional[str] = None
    attributes: Dict[str, JsonValue] = {}
    for layer in layers:
        if layer is None:
            continue
        if layer.targeting_key is not None:
            targeting_key = layer.targeting_key
        attributes.update(dict(layer.attributes))
    return EvaluationContext(targeting_key=targeting_key, attributes=attributes)


def _max_depth(value: Any) -> int:
    if isinstance(value, dict):
        return 1 + max((_max_depth(v) for v in value.values()), default=0)
    if isinstance(value, list):
        return 1 + max((_max_depth(v) for v in value), default=0)
    return 0


def _iter_keys(value: Any) -> Iterable[str]:
    if isinstance(value, dict):
        for k, v in value.items():
            yield k
            yield from _iter_keys(v)
    elif isinstance(value, list):
        for v in value:
            yield from _iter_keys(v)


def _iter_string_leaves(value: Any) -> Iterable[str]:
    if isinstance(value, dict):
        for v in value.values():
            yield from _iter_string_leaves(v)
    elif isinstance(value, list):
        for v in value:
            yield from _iter_string_leaves(v)
    elif isinstance(value, str):
        yield value


def validate_context(
    context: EvaluationContext,
    *,
    limits: ContextLimits,
    reserved_keys: Tuple[str, ...] = _DEFAULT_RESERVED_KEYS,
    require_targeting_key: bool = False,
) -> None:
    """Validate a merged context; raise :class:`InvalidContextError` on breach.

    Check order (deterministic, cheap-first): targeting key, reserved keys,
    attribute count, key size, value size, nesting depth, serialized size.
    Validation always happens *before* any backend call.
    """
    if require_targeting_key and not context.targeting_key:
        raise TargetingKeyMissingError()

    attrs = dict(context.attributes)

    reserved = set(reserved_keys)
    for key in attrs:
        if key in reserved:
            raise InvalidContextError("invalid evaluation context")
        if key.startswith("fireweave.") and key not in _ALLOWED_FIREWEAVE_KEYS:
            raise InvalidContextError("invalid evaluation context")

    if len(attrs) > limits.max_attribute_count:
        raise InvalidContextError("context exceeds maximum attribute count")

    for key in _iter_keys(attrs):
        if len(key.encode("utf-8")) > limits.max_key_bytes:
            raise InvalidContextError("context key exceeds maximum size")

    for leaf in _iter_string_leaves(attrs):
        if len(leaf.encode("utf-8")) > limits.max_value_bytes:
            raise InvalidContextError("context value exceeds maximum size")

    if _max_depth(attrs) > limits.max_nesting_depth:
        raise InvalidContextError("context exceeds maximum nesting depth")

    serialized = json.dumps(
        {"targetingKey": context.targeting_key, "attributes": attrs},
        separators=(",", ":"),
        ensure_ascii=False,
        default=str,
    )
    if len(serialized.encode("utf-8")) > limits.max_serialized_bytes:
        raise InvalidContextError("serialized context exceeds maximum size")
