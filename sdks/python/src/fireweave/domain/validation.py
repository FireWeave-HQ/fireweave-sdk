"""Fireweave SDK validation — pure, total functions per spec/control-points.md
"Validation, before any I/O" and spec/modes.md "Initialisation validation".

Every read-path validator here (`validate_control_point_key`,
`validate_default_value`, `validate_context`, `validate_targeting_key`)
returns a :class:`Validated` instead of raising. :meth:`FireweaveRuntime.evaluate`
(application/runtime.py) runs them, in the fixed order the spec names — key,
default-vs-type, context, lifecycle — and degrades to the caller's default on
the first failure; it NEVER raises for a malformed/unresolvable read
(spec/control-points.md "Return discipline — never throw into a read path").

`validate_init_options` is the one named exception (spec/modes.md
"Initialisation validation"): its failures are converted to a RAISE by
`init_fireweave` (application/mode.py). The validator itself still returns a
`Validated` like every other validator — the entry point does the raising,
not this module.

Mirrors node's five validator names (validateControlPointKey,
validateDefaultValue, validateContext, validateTargetingKey,
validateInitOptions), snake_cased. Everything below is pure (no I/O, no
ambient state, no `os.environ` reads) and total (every branch returns a
`Validated`) — `conformance/` can exercise all four read-path rules offline,
with no backend.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Generic, Mapping, Optional, TypeVar

from .context import ALLOWED_FIREWEAVE_CONTEXT_KEYS, DEFAULT_RESERVED_ATTRIBUTE_KEYS, ContextLimits, EvaluationContext
from .errors import ConfigurationError, FireweaveError, FlagNotFoundError, InvalidContextError, TargetingKeyMissingError, TypeMismatchError
from .types import FlagType, JsonValue

__all__ = [
    "Validated",
    "validate_control_point_key",
    "matches_expected_type",
    "validate_default_value",
    "validate_targeting_key",
    "validate_context",
    "validate_init_options",
]

T = TypeVar("T")


@dataclass(frozen=True)
class Validated(Generic[T]):
    """Result of a pure validator: success carries `value`, failure carries
    the canonical `error` (python idiom for node's `Validated<T>` union)."""

    ok: bool
    value: Optional[T] = None
    error: Optional[FireweaveError] = None


def _ok(value: T) -> Validated[T]:
    return Validated(ok=True, value=value)


def _fail(error: FireweaveError) -> Validated[Any]:
    return Validated(ok=False, error=error)


# ---------------------------------------------------------------------------
# Rule 1 — validate_control_point_key (spec/control-points.md "Validation,
# before any I/O": "key — non-empty, <=256 characters, no control characters")
# ---------------------------------------------------------------------------

_MAX_CONTROL_POINT_KEY_LENGTH = 256


def _has_control_characters(key: str) -> bool:
    # C0 + C1 control characters (U+0000-U+001F, U+007F-U+009F). Uses
    # ord() comparisons rather than embedding raw control bytes in a
    # string literal, which is unreadable in a diff/editor.
    return any(ord(ch) <= 0x1F or 0x7F <= ord(ch) <= 0x9F for ch in key)


def validate_control_point_key(key: Any) -> Validated[str]:
    """key — non-empty, <=256 characters, no control characters
    (spec/control-points.md rule 1, the first check in the fixed order).

    No taxonomy kind names "malformed key" explicitly (the return-discipline
    table's closest row is "key unknown to the backend" -> FlagNotFound): a
    key that can never identify a flag is treated the same as one the backend
    doesn't recognise, so this maps to FlagNotFound too.

    Controller-ruled interim mapping (carried over from the node reference,
    Task 3 review): the 15-kind taxonomy in errors.schema.json is frozen at
    exactly 15 entries, InvalidContext is textually scoped to the evaluation
    *context* (not the key), and the schema already maps another non-literal
    case — quota-limited responses — onto FlagNotFound rather than adding a
    kind for it. FlagNotFound is therefore the least-wrong existing kind, not
    a literal fit. Other-language implementations copying node as the
    reference SHOULD use the same mapping rather than each independently
    guessing a different one.
    """
    if not isinstance(key, str) or len(key) == 0:
        return _fail(FlagNotFoundError("control point key must be a non-empty string"))
    if len(key) > _MAX_CONTROL_POINT_KEY_LENGTH:
        return _fail(FlagNotFoundError("control point key exceeds maximum length"))
    if _has_control_characters(key):
        return _fail(FlagNotFoundError("control point key contains control characters"))
    return _ok(key)


# ---------------------------------------------------------------------------
# Rule 2 — validate_default_value (spec/control-points.md rule 2: "default vs
# type — getBooleanValue with a non-boolean default is TypeMismatch")
# ---------------------------------------------------------------------------


def matches_expected_type(value: Any, expected: FlagType) -> bool:
    """Whether `value` matches the shape `expected` names. Shared by
    :func:`validate_default_value` (the caller's default, before any I/O) and
    the runtime's post-resolve check (the backend's resolved value, after
    I/O) — same predicate, two different inputs.

    ``bool`` is never accepted as NUMBER: Python's ``bool`` is a subclass of
    ``int``, and a caller passing ``True``/``False`` as a numeric default is a
    call-site mistake the spec wants surfaced, not silently coerced.
    """
    if expected is FlagType.BOOLEAN:
        return isinstance(value, bool)
    if expected is FlagType.STRING:
        return isinstance(value, str)
    if expected is FlagType.NUMBER:
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected is FlagType.OBJECT:
        return isinstance(value, (dict, list))
    return False


def validate_default_value(expected_type: FlagType, default_value: JsonValue) -> Validated[JsonValue]:
    """default vs type — e.g. `get_boolean_value` with a non-boolean default
    is TypeMismatch (spec/control-points.md rule 2, checked before any I/O)."""
    if not matches_expected_type(default_value, expected_type):
        return _fail(TypeMismatchError())
    return _ok(default_value)


# ---------------------------------------------------------------------------
# validate_targeting_key (spec/control-points.md "Context": targetingKey)
# ---------------------------------------------------------------------------


def validate_targeting_key(targeting_key: Optional[str], required: bool) -> Validated[Optional[str]]:
    """targetingKey: "An SDK MUST NOT invent one: a missing targeting key is
    InvalidContext where the evaluation needs it, never a generated anonymous
    id" (spec/control-points.md "Context"). `required` is call-site policy —
    the remote adapter always requires one; the generic context pipeline
    (`validate_context`) only does when its caller opts in."""
    if required and (targeting_key is None or targeting_key == ""):
        return _fail(TargetingKeyMissingError())
    return _ok(targeting_key)


# ---------------------------------------------------------------------------
# Rule 3 — validate_context (spec/control-points.md rule 3: "context — depth,
# key count, value size, reserved keys (evaluation-context.schema.json)")
# ---------------------------------------------------------------------------


def _max_depth(value: Any) -> int:
    if isinstance(value, dict):
        return 1 + max((_max_depth(v) for v in value.values()), default=0)
    if isinstance(value, list):
        return 1 + max((_max_depth(v) for v in value), default=0)
    return 0


def _iter_keys(value: Any):
    if isinstance(value, dict):
        for k, v in value.items():
            yield k
            yield from _iter_keys(v)
    elif isinstance(value, list):
        for v in value:
            yield from _iter_keys(v)


def _iter_string_leaves(value: Any):
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
    reserved_keys=DEFAULT_RESERVED_ATTRIBUTE_KEYS,
    require_targeting_key: bool = False,
) -> Validated[EvaluationContext]:
    """context — depth, key count, value size, reserved keys
    (evaluation-context.schema.json) (spec/control-points.md rule 3). Also
    enforces `require_targeting_key` via :func:`validate_targeting_key`.

    `context` is already a canonicalized, cycle-safe :class:`EvaluationContext`
    (domain/context.py's `__post_init__` deep-copies defensively — Python
    containers can be cyclic too — so construction itself never raises;
    reaching this function with one is therefore already safe).
    """

    attrs = dict(context.attributes)

    reserved = set(reserved_keys)
    for key in attrs:
        if key in reserved:
            return _fail(InvalidContextError("invalid evaluation context"))
        if key.startswith("fireweave.") and key not in ALLOWED_FIREWEAVE_CONTEXT_KEYS:
            return _fail(InvalidContextError("invalid evaluation context"))

    if len(attrs) > limits.max_attribute_count:
        return _fail(InvalidContextError("context exceeds maximum attribute count"))

    for key in _iter_keys(attrs):
        if len(key.encode("utf-8")) > limits.max_key_bytes:
            return _fail(InvalidContextError("context key exceeds maximum size"))

    for leaf in _iter_string_leaves(attrs):
        if len(leaf.encode("utf-8")) > limits.max_value_bytes:
            return _fail(InvalidContextError("context value exceeds maximum size"))

    if _max_depth(attrs) > limits.max_nesting_depth:
        return _fail(InvalidContextError("context exceeds maximum nesting depth"))

    serialized = json.dumps(
        {"targetingKey": context.targeting_key, "attributes": attrs},
        separators=(",", ":"),
        ensure_ascii=False,
        default=str,
    )
    if len(serialized.encode("utf-8")) > limits.max_serialized_bytes:
        return _fail(InvalidContextError("serialized context exceeds maximum size"))

    targeting_result = validate_targeting_key(context.targeting_key, require_targeting_key)
    if not targeting_result.ok:
        return targeting_result  # type: ignore[return-value]

    return _ok(context)


# ---------------------------------------------------------------------------
# validate_init_options (spec/modes.md "Initialisation validation")
# ---------------------------------------------------------------------------


def _is_blank(value: Any) -> bool:
    """"missing" and "blank" collapse to one check: not a non-empty string."""
    return not isinstance(value, str) or value.strip() == ""


def validate_init_options(options: Mapping[str, Any]) -> Validated[Mapping[str, Any]]:
    """Initialisation-validation table (spec/modes.md), rows 1, 2 and 4:

    - `mode` absent or unrecognised
    - `mode="remote"` with `api_key` or `api_url` missing/blank
    - `mode="local"` with credentials supplied (a config half-migrated from
      remote to local reads as neither, silently — reject it instead)

    Row 3 ("apiUrl fails the host allowlist") is intentionally NOT checked
    here — that check (`assert_host_allowed`) lives in
    `infrastructure/hosts.py`, and is invoked directly by
    `application/mode.py` before any adapter/network I/O happens.
    """
    mode = options.get("mode")
    if mode not in ("local", "remote"):
        return _fail(ConfigurationError('mode is required and must be "local" or "remote"'))
    if mode == "remote":
        if _is_blank(options.get("api_key")) or _is_blank(options.get("api_url")):
            return _fail(ConfigurationError('mode "remote" requires api_key and api_url'))
        return _ok(options)
    # mode == "local"
    if not _is_blank(options.get("api_key")) or not _is_blank(options.get("api_url")):
        return _fail(
            ConfigurationError(
                'mode "local" must not be combined with api_key/api_url — the caller means one or the other'
            )
        )
    return _ok(options)
