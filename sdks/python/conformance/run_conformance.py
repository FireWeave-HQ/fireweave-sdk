#!/usr/bin/env python3
"""CLI entry point: run the 65 contracts fixtures, emit the compatibility
report (contracts/README.md schema — fixtureId/suite/language/status/
limitation/message rows, same shape node/go/java write).

Usage::

    python conformance/run_conformance.py [--contracts PATH] [--out PATH]

Exit code is non-zero when any fixture fails (harness.md runner obligation).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from runner import run_all  # noqa: E402


def main() -> int:
    repo_root = Path(__file__).resolve().parents[3]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--contracts", type=Path, default=repo_root / "contracts",
        help="Path to the contracts fixture directory",
    )
    parser.add_argument(
        "--out", type=Path,
        default=Path(__file__).resolve().parent / "compatibility-report.python.json",
        help="Where to write the compatibility report JSON",
    )
    args = parser.parse_args()

    report = run_all(args.contracts)
    args.out.write_text(json.dumps(report, indent=2, default=str) + "\n")

    summary = report["summary"]
    print(
        f"conformance[python]: {summary['pass']} passed, {summary['fail']} failed, "
        f"{summary['skipped-with-documented-limitation']} skipped-with-documented-limitation, "
        f"{summary['skipped-v1-out-of-scope']} skipped-v1-out-of-scope "
        f"(report: {args.out})"
    )
    for row in report["results"]:
        if row["status"] == "fail":
            print(f"  FAIL {row['suite']}/{row['fixtureId']}")
            if row["message"]:
                print(f"       - {row['message']}")
        elif row["status"] not in ("pass",):
            print(f"  SKIP {row['suite']}/{row['fixtureId']}: {row['limitation']}")
    return 1 if summary["fail"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
