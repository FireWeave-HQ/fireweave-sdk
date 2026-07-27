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


@pytest.fixture()
def client(simple_flags) -> FireweaveClient:
    runtime = FireweaveRuntime(InMemoryAdapter(simple_flags))
    runtime.initialize()
    c = FireweaveClient(runtime)
    yield c
    c.shutdown()
