"""The control-points object: every control point the app reads, with the value
served in local mode. It lives in its own module (the app's choice, e.g.
``src/fireweave_setup/control_points.py``) and is passed as
``start(control_points=control_points)``.

It holds local values only. In remote mode fw-server and the rollout decide,
and call sites keep ``False`` as their default (RAMP-1), so this file can
never switch a feature on in production.
"""

from __future__ import annotations

import os
import sys
import threading
from typing import Any, Dict, Mapping, Optional, Tuple, TypedDict

from fireweave import ConfigurationError, validate_control_point_key


class _ControlPointDefinitionRequired(TypedDict):
    local: bool


class ControlPointDefinition(_ControlPointDefinitionRequired, total=False):
    """One control point. ``local`` is served in local mode only;
    ``description`` is a note for humans and agents, never sent anywhere."""

    description: str


ControlPointMap = Mapping[str, ControlPointDefinition]

# Where each define_control_points() mapping was declared, keyed by id(). The mapping
# itself is held too, so an id can never be reused while its entry exists.
# Only used to name the declaring file in the local missing-key warning.
_DEFINED_AT: Dict[int, Tuple[Mapping[str, Any], str]] = {}
_DEFINED_LOCK = threading.Lock()


def _config_error(message: str) -> ConfigurationError:
    return ConfigurationError(message, init_fatal=True)


def normalize_control_points(control_points: Any) -> Dict[str, ControlPointDefinition]:
    """Validate a control-points mapping and return a plain copy. Raises
    ConfigurationError on a bad entry."""
    if control_points is None:
        return {}
    if not isinstance(control_points, Mapping):
        raise _config_error('[fireweave] start(control_points=...) must be a mapping of {"key": {"local": bool}}.')
    out: Dict[str, ControlPointDefinition] = {}
    for key, entry in control_points.items():
        if not validate_control_point_key(key).ok:
            raise _config_error(f"[fireweave] control_points: {key!r} is not a valid control point key.")
        if not isinstance(entry, Mapping) or not isinstance(entry.get("local"), bool):
            raise _config_error(f'[fireweave] control_points[{key!r}] must be {{"local": True}} or {{"local": False}}.')
        description = entry.get("description")
        if description is not None and not isinstance(description, str):
            raise _config_error(f"[fireweave] control_points[{key!r}]['description'] must be a string.")
        definition: ControlPointDefinition = {"local": entry["local"]}
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


def define_control_points(control_points: Mapping[str, ControlPointDefinition]) -> Mapping[str, ControlPointDefinition]:
    """Declare the app's control points. Returns its argument unchanged and
    checks it at import time, so a typo fails where it was made::

        control_points = define_control_points({
            "new-checkout": {"local": True, "description": "One-page checkout"},
        })
    """
    normalize_control_points(control_points)
    where = _caller_file()
    if where is not None:
        with _DEFINED_LOCK:
            _DEFINED_AT[id(control_points)] = (control_points, where)
    return control_points


def control_points_file(control_points: Any) -> Optional[str]:
    """The file that declared ``control_points`` through define_control_points(), if known."""
    with _DEFINED_LOCK:
        entry = _DEFINED_AT.get(id(control_points))
    return entry[1] if entry is not None and entry[0] is control_points else None


def to_local_control_points(control_points: Mapping[str, ControlPointDefinition]) -> Dict[str, bool]:
    """The core local adapter's seed map."""
    return {key: entry["local"] for key, entry in control_points.items()}
