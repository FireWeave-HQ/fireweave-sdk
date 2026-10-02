"""The flags object: every control point the app reads, with the value served
in local mode. It lives in its own module (the app's choice, e.g.
``src/fireweave_setup/flags.py``) and is passed as ``start(flags=flags)``.

It holds local values only. In remote mode fw-server and the rollout decide,
and call sites keep ``False`` as their default (RAMP-1), so a flags file can
never switch a feature on in production.
"""

from __future__ import annotations

import os
import sys
import threading
from typing import Any, Dict, Mapping, Optional, Tuple, TypedDict

from fireweave import ConfigurationError, validate_control_point_key


class _FlagDefinitionRequired(TypedDict):
    local: bool


class FlagDefinition(_FlagDefinitionRequired, total=False):
    """One control point. ``local`` is served in local mode only;
    ``description`` is a note for humans and agents, never sent anywhere."""

    description: str


FlagMap = Mapping[str, FlagDefinition]

# Where each define_flags() mapping was declared, keyed by id(). The mapping
# itself is held too, so an id can never be reused while its entry exists.
# Only used to name the flags file in the local missing-key warning.
_DEFINED_AT: Dict[int, Tuple[Mapping[str, Any], str]] = {}
_DEFINED_LOCK = threading.Lock()


def _config_error(message: str) -> ConfigurationError:
    return ConfigurationError(message, init_fatal=True)


def normalize_flags(flags: Any) -> Dict[str, FlagDefinition]:
    """Validate a flags mapping and return a plain copy. Raises
    ConfigurationError on a bad entry."""
    if flags is None:
        return {}
    if not isinstance(flags, Mapping):
        raise _config_error('[fireweave] start(flags=...) must be a mapping of {"key": {"local": bool}}.')
    out: Dict[str, FlagDefinition] = {}
    for key, entry in flags.items():
        if not validate_control_point_key(key).ok:
            raise _config_error(f"[fireweave] flags: {key!r} is not a valid control point key.")
        if not isinstance(entry, Mapping) or not isinstance(entry.get("local"), bool):
            raise _config_error(f'[fireweave] flags[{key!r}] must be {{"local": True}} or {{"local": False}}.')
        description = entry.get("description")
        if description is not None and not isinstance(description, str):
            raise _config_error(f"[fireweave] flags[{key!r}]['description'] must be a string.")
        definition: FlagDefinition = {"local": entry["local"]}
        if description is not None:
            definition["description"] = description
        out[key] = definition
    return out


def _caller_file() -> Optional[str]:
    try:
        path = sys._getframe(2).f_code.co_filename
    except (AttributeError, ValueError):  # not CPython, or no such frame
        return None
    if path.startswith("<"):
        return None
    try:
        rel = os.path.relpath(path)
    except ValueError:  # another drive on Windows
        return path
    return path if rel.startswith("..") else rel


def define_flags(flags: Mapping[str, FlagDefinition]) -> Mapping[str, FlagDefinition]:
    """Declare the app's control points. Returns its argument unchanged and
    checks it at import time, so a typo fails where it was made::

        flags = define_flags({
            "new-checkout": {"local": True, "description": "One-page checkout"},
        })
    """
    normalize_flags(flags)
    where = _caller_file()
    if where is not None:
        with _DEFINED_LOCK:
            _DEFINED_AT[id(flags)] = (flags, where)
    return flags


def flags_file(flags: Any) -> Optional[str]:
    """The file that declared ``flags`` through define_flags(), if known."""
    with _DEFINED_LOCK:
        entry = _DEFINED_AT.get(id(flags))
    return entry[1] if entry is not None and entry[0] is flags else None


def to_local_control_points(flags: Mapping[str, FlagDefinition]) -> Dict[str, bool]:
    """The core local adapter's seed map."""
    return {key: entry["local"] for key, entry in flags.items()}
