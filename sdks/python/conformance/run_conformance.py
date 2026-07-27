#!/usr/bin/env python3
"""CLI entry point: run the 63 contracts fixtures, emit normalized results JSON.

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
        default=Path(__file__).resolve().parent / "results.python.json",
        help="Where to write the normalized results JSON",
    )
    args = parser.parse_args()

    summary = run_all(args.contracts)
    args.out.write_text(json.dumps(summary, indent=2, default=str) + "\n")

    print(
        f"conformance[{summary['language']}]: "
        f"{summary['passed']} passed, {summary['failed']} failed, "
        f"{summary['skipped']} skipped-with-documented-limitation "
        f"(of {summary['total']})"
    )
    for res in summary["results"]:
        if res["status"] == "fail":
            print(f"  FAIL {res['suite']}/{res['id']}")
            for diff in res.get("diffs", []):
                print(f"       - {diff}")
        elif res["status"] != "pass":
            print(f"  SKIP {res['suite']}/{res['id']}: {res.get('limitation')}")
    return 1 if summary["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
