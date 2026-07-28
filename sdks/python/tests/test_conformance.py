"""Runs every contracts/ fixture through the conformance runner as pytest cases."""

from __future__ import annotations

from pathlib import Path

import pytest

from runner import load_fixtures, run_fixture

CONTRACTS_DIR = Path(__file__).resolve().parents[3] / "contracts"
FIXTURES = load_fixtures(CONTRACTS_DIR)


@pytest.mark.parametrize("fixture", FIXTURES, ids=[f["id"] for f in FIXTURES])
def test_fixture(fixture):
    result = run_fixture(fixture)
    if result["status"] == "skipped-with-documented-limitation":
        pytest.skip(result.get("limitation") or "documented limitation")
    assert result["status"] == "pass", result.get("diffs")


def test_fixture_count_matches_canonical_inventory():
    # 65 = Phase-3's 63 + ctx-fireweave-groups-carveout + ext-lifecycle-gating
    # (contracts/README.md canonical inventory).
    assert len(FIXTURES) == 65
