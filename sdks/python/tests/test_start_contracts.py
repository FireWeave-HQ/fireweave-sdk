"""The shared start-profile suite (contracts/start/, spec/start-profile.md) on
Python. Python has only the server profile (plus the ``any`` fixtures): drives
the pure resolver (fireweave/start/_resolve.py), the instance-key derivation
with an injected host name, define_control_points and channel_for_version, compares by
the rules in contracts/start/README.md, and writes
conformance/compatibility-report.start.python.json (gitignored).

One test per fixture declared ``pass`` for python, so a failure names the
fixture and every failing case.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

from fireweave import ConfigurationError
from fireweave.start import define_control_points
from fireweave.start._build_info import channel_for_version
from fireweave.start._env import env_from_mapping
from fireweave.start._instance import derive_instance_key
from fireweave.start._names import ENV, ENVIRONMENT_FALLBACKS, LEGACY_ENV
from fireweave.start._resolve import resolve_start

LANG = "python"
_SDK_DIR = Path(__file__).resolve().parents[1]
CONTRACTS_DIR = _SDK_DIR.parents[1] / "contracts" / "start"
REPORT_PATH = _SDK_DIR / "conformance" / "compatibility-report.start.python.json"

#: Variable names stay as they are when sources are normalised.
KNOWN_NAMES = frozenset(
    [ENV["key"], ENV["url"], ENV["environment"], *ENVIRONMENT_FALLBACKS, *LEGACY_ENV["key"], *LEGACY_ENV["url"]]
)


def _load_fixtures() -> List[Dict[str, Any]]:
    paths = sorted(p for p in CONTRACTS_DIR.glob("*.json") if p.name != "start-fixture.schema.json")
    return [json.loads(p.read_text(encoding="utf-8")) for p in paths]


FIXTURES = _load_fixtures()


def normalise_source(source: Optional[str]) -> Optional[str]:
    """contracts/start/README.md "Comparing results": a variable name stays;
    a ``start(...=...)`` source becomes ``option``; the channel default
    (``SDK channel (...)``) becomes ``channel``; no key stays ``none``."""
    if source is None:
        return None
    if source == "none":
        return "none"
    if source.startswith("SDK channel"):
        return "channel"
    if source in KNOWN_NAMES:
        return source
    return "option"


class Outcome:
    def __init__(
        self,
        fields: Optional[Dict[str, Any]] = None,
        warnings: Optional[List[str]] = None,
        error: Optional[ConfigurationError] = None,
    ):
        self.fields = fields or {}
        self.warnings = warnings or []
        self.error = None if error is None else {"kind": error.kind.value, "message": error.message or str(error)}


def run_resolve(case: Dict[str, Any]) -> Outcome:
    when = case["when"]
    options = when.get("options", {})
    try:
        r = resolve_start(
            read=env_from_mapping(when.get("env", {})),
            sdk_version="0.0.0-contract",
            channel=when.get("channel", "production"),
            mode=options.get("mode"),
            environment=options.get("environment"),
            url=options.get("url"),
            key=options.get("key"),
        )
    except ConfigurationError as err:
        return Outcome(error=err)
    return Outcome(
        warnings=list(r.warnings),
        fields={
            "mode": r.mode,
            "modeSource": r.mode_source,
            "url": r.url,
            "urlSource": normalise_source(r.url_source),
            "allowedHosts": None if r.allowed_hosts is None else list(r.allowed_hosts),
            "keySource": normalise_source(r.key_source),
            "environment": r.environment,
            "environmentSource": normalise_source(r.environment_source),
        },
    )


def run_instance_key(case: Dict[str, Any]) -> Outcome:
    when = case["when"]
    instance_id = when.get("options", {}).get("instanceId")
    # The same option handling as start(instance_id=...) in _state.py.
    option = (instance_id.strip() or None) if instance_id is not None else None
    host: Optional[str] = when["hostName"]
    key = derive_instance_key(option, env_from_mapping(when["env"]), lambda: host)
    return Outcome(fields={"value": key.value})


def run_define_control_points(case: Dict[str, Any]) -> Outcome:
    try:
        define_control_points(case["when"]["controlPoints"])
    except ConfigurationError as err:
        return Outcome(error=err)
    return Outcome(fields={"ok": True})


def run_channel_for_version(case: Dict[str, Any]) -> Outcome:
    return Outcome(fields={"channel": channel_for_version(case["when"]["version"])})


_OPERATIONS = {
    "resolve": run_resolve,
    "instanceKey": run_instance_key,
    "defineControlPoints": run_define_control_points,
    "channelForVersion": run_channel_for_version,
}


def compare(expect: Dict[str, Any], out: Outcome) -> List[str]:
    """The list of differences; empty when the case passes."""
    diffs: List[str] = []
    err = expect.get("error")
    if err is not None:
        if out.error is None:
            return [f"expected a {err['kind']} error, got {json.dumps(out.fields)}"]
        if out.error["kind"] != err["kind"]:
            diffs.append(f"error kind {out.error['kind']}, expected {err['kind']}")
        for name in err.get("mentions", []):
            if name not in out.error["message"]:
                diffs.append(f"error does not mention {name}: {out.error['message']}")
        for name in err.get("mustNotMention", []):
            if name in out.error["message"]:
                diffs.append(f"error mentions {name}")
        return diffs
    if out.error is not None:
        return [f"unexpected {out.error['kind']} error: {out.error['message']}"]
    for field, want in expect.items():
        if field == "warnings":
            for name in want.get("mention", []):
                if not any(name in line for line in out.warnings):
                    diffs.append(f"no warning mentions {name}")
            for name in want.get("mustNotMention", []):
                if any(name in line for line in out.warnings):
                    diffs.append(f"a warning mentions {name}")
            continue
        if field == "prefix":
            value = str(out.fields.get("value") or "")
            if not value.startswith(want):
                diffs.append(f"value {value} does not start with {want}")
            continue
        got = out.fields.get(field)
        if field == "allowedHosts" and isinstance(want, list) and isinstance(got, list):
            if set(want) != set(got):
                diffs.append(f"allowedHosts {json.dumps(got)}, expected {json.dumps(want)}")
            continue
        if got != want:
            diffs.append(f"{field} {json.dumps(got)}, expected {json.dumps(want)}")
    return diffs


def _run_fixture(fx: Dict[str, Any]) -> Dict[str, Any]:
    if fx["compatibility"][LANG] == "not-applicable":
        return {"fixtureId": fx["id"], "status": "not-applicable", "cases": [], "message": ""}
    cases: List[Dict[str, Any]] = []
    for case in fx["cases"]:
        applies = case.get("appliesTo")
        if applies is not None and LANG not in applies:
            cases.append({"name": case["name"], "status": "not-applicable"})
            continue
        operation = _OPERATIONS.get(case["when"]["operation"])
        if operation is None:
            diffs = [f"operation {case['when']['operation']} is not applicable to {LANG}"]
        else:
            diffs = compare(case["expect"], operation(case))
        if diffs:
            cases.append({"name": case["name"], "status": "fail", "message": "; ".join(diffs)})
        else:
            cases.append({"name": case["name"], "status": "pass"})
    failed = [c for c in cases if c["status"] == "fail"]
    return {
        "fixtureId": fx["id"],
        "status": "fail" if failed else "pass",
        "cases": cases,
        "message": " | ".join(f"{c['name']}: {c['message']}" for c in failed),
    }


RESULTS = [_run_fixture(fx) for fx in FIXTURES]
REPORT_PATH.write_text(
    json.dumps({"language": LANG, "suite": "start", "results": RESULTS}, indent=2) + "\n", encoding="utf-8"
)

_DECLARED_PASS = [r for r, fx in zip(RESULTS, FIXTURES) if fx["compatibility"][LANG] == "pass"]


def test_contracts_start_has_fixtures():
    assert len(FIXTURES) >= 10, "expected the shared start-profile suite"


@pytest.mark.parametrize("result", _DECLARED_PASS, ids=[r["fixtureId"] for r in _DECLARED_PASS])
def test_contracts_start(result):
    assert result["status"] == "pass", result["message"]
