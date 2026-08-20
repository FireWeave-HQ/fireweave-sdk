"""Runs every contracts/ fixture through the conformance runner as pytest cases.

DEFERRED (SDD IMPLEMENTATION-PLAN Task 10, "Phase 4: conformance runner
rewrite"): `conformance/runner.py` still speaks the pre-v1 architecture
(`FireweaveConfig`, the extension namespaces via `CapabilityRegistry`, the
PostHog adapter) that this task's v1 cut removes. Rewriting the fixture
runner for the v1 control-points surface is Task 10's job, across every
language. Skipped here rather than patched up, mirroring node/web — neither
ships a `contracts/`-fixture pytest runner today; `conformance/surface/` is
the parity gate this task satisfies instead
(conformance/surface/control-points.surface.json).
"""

from __future__ import annotations

import pytest

pytest.skip(
    "conformance/runner.py targets the pre-v1 (FireweaveConfig / extension "
    "namespaces / PostHog adapter) architecture; rewrite is Task 10",
    allow_module_level=True,
)
