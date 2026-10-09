from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Make the conformance runner importable from tests.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "conformance"))

from fireweave import FireweaveClient, FireweaveRuntime, InMemoryAdapter


@pytest.fixture()
def simple_flags():
    return {
        "bool-on": {
            "type": "boolean",
            "enabled": True,
            "variant": "on",
            "value": True,
            "metadata": {"version": 1},
        },
        "theme": {
            "type": "string",
            "enabled": True,
            "variant": "dark",
            "value": "dark",
            "metadata": {"version": 2},
        },
    }


#: Every variable the start profile reads, including the ones it reads only
#: to word an error. Cleared around start-profile tests so a contributor
#: shell holding FIREWEAVE_KEY cannot turn them remote.
START_PROFILE_ENV_NAMES = (
    "FIREWEAVE_KEY",
    "FIREWEAVE_URL",
    "FIREWEAVE_ENV",
    "FIREWEAVE_INSTANCE_ID",
    "FW_PROJECT_API_KEY",
    "FW_API_URL",
    "FW_ATTEST_URL",
    "FW_ENV",
    "APP_ENV",
)


@pytest.fixture()
def start_profile(monkeypatch):
    """A clean start-profile singleton and environment, before and after."""
    from fireweave.start import reset_for_tests

    for name in START_PROFILE_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    reset_for_tests()
    yield
    reset_for_tests()


@pytest.fixture()
def client(simple_flags) -> FireweaveClient:
    runtime = FireweaveRuntime(InMemoryAdapter(simple_flags))
    runtime.initialize()
    c = FireweaveClient(runtime)
    yield c
    c.shutdown()
