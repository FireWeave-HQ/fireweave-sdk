"""Runs every contracts/ fixture through conformance/runner.py as pytest
cases (contracts/harness.md). Parametrized per fixture so a failure names the
fixture directly rather than hiding inside one aggregate assertion.

Previously DEFERRED (SDD IMPLEMENTATION-PLAN Task 10): conformance/runner.py
targeted the pre-v1 architecture (FireweaveConfig, the extension namespaces
via CapabilityRegistry, the PostHog adapter). Task 10 rewrote the runner for
the v1 control-points surface; this file un-skips accordingly.

Fixtures still marked `xfail` below (not skipped, not hidden — pytest still
runs them and reports XFAIL with the reason given) surface real gaps outside
this task's scope (the controller decides whether each is a fix-now or a
follow-up). `conformance/runner.py#run_fixture` still reports their TRUE
status ("fail") to compatibility-report.python.json — only this pytest
wrapper softens the CI-blocking consequence, and only for the fixtures named
below, with a reason.

Task 10b (task-10b-report.md) fixed sec-endpoint-ssrf-allowlist (src/ fix:
hosts.assert_host_allowed's ConfigurationError now threads init_fatal=True at
both call sites), flipped eval-numeric-coercion-int-float's
compatibility.python to the genuinely-declared skipped-with-documented-
limitation (controller-ruled fixture edit), and implemented eval-payload-
attached (application/ports.EvaluateOptions.include_payload, threaded through
FireweaveRuntime.evaluate/_ControlPointsNamespace.evaluate) — all three
removed from _KNOWN_GAPS below; _KNOWN_GAPS is now empty.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

CONFORMANCE_DIR = Path(__file__).resolve().parents[1] / "conformance"
sys.path.insert(0, str(CONFORMANCE_DIR))

from runner import load_fixtures, run_fixture  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]
CONTRACTS_DIR = REPO_ROOT / "contracts"

_FIXTURES = load_fixtures(CONTRACTS_DIR)

# Known, out-of-scope gaps (see task-10-report.md "Concerns" for the original
# writeup and task-10b-report.md for what since got fixed). Each entry would be
# a genuine divergence between the frozen fixture's declared
# `compatibility.python: "pass"` and actual SDK behavior — not a runner bug.
# Empty as of task-10b: all three of python's known gaps were fixed.
_KNOWN_GAPS = {}


def _id(fixture):
    return f"{fixture['suite']}/{fixture['id']}"


def _params():
    for fixture in _FIXTURES:
        reason = _KNOWN_GAPS.get(fixture["id"])
        marks = [pytest.mark.xfail(reason=reason, strict=False)] if reason is not None else []
        yield pytest.param(fixture, id=_id(fixture), marks=marks)


@pytest.mark.parametrize("fixture", list(_params()))
def test_fixture_conforms(fixture):
    row = run_fixture(fixture)
    if row["status"] == "fail":
        pytest.fail(f"{row['fixtureId']}: {row['message']}")
    assert row["status"] in (
        "pass",
        "skipped-with-documented-limitation",
        "skipped-v1-out-of-scope",
    )


def test_canonical_inventory_is_65_fixtures():
    assert len(_FIXTURES) == 65, f"expected 65 fixtures, found {len(_FIXTURES)}"
