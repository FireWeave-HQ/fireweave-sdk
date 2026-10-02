"""The ONLY place the SDK reads the process environment or the host name.

The core SDK reads no environment variables (spec/modes.md). The start
profile is the documented exception (docs/adr/0011-start-profile.md), and
tests/test_start_guards.py pins every ``os.environ`` / ``os.getenv`` read and
every host-name lookup to this file.
"""

from __future__ import annotations

import os
import socket
from typing import Any, Callable, Mapping, Optional

#: Reads one variable. Returns None when unset, empty, or only whitespace.
EnvReader = Callable[[str], Optional[str]]


def _clean(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed or None


def env_from_mapping(bag: Mapping[str, Any]) -> EnvReader:
    """Reader over an explicit mapping (``start(env=...)`` and tests). Only
    string values count."""
    return lambda name: _clean(bag.get(name))


def process_env() -> EnvReader:
    """Reader over the running process. Looked up per read, so a value set
    after import (python-dotenv's ``load_dotenv()``) is still seen."""
    return lambda name: _clean(os.environ.get(name))


def host_name() -> Optional[str]:
    """This machine's host name, or None when the platform will not say."""
    try:
        return _clean(socket.gethostname())
    except OSError:
        return None
