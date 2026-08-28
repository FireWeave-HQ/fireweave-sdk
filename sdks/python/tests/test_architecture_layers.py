"""Layering guard (spec/control-points.md + spec/modes.md, "same layering" as
the node reference SDK):

 - the SDK stays dependency-free — `pyproject.toml`'s
   `[project].dependencies` never grows beyond an empty list;
 - `src/fireweave/domain/` stays pure — it imports nothing from
   `application/` or `infrastructure/`, so the same rules/types port to
   every target language's validation layer without dragging adapters or
   runtime wiring along;
 - `src/fireweave/application/` does not reach into `infrastructure/` except
   through the one sanctioned seam: `mode.py`, the composition root (its
   whole job is adapter selection, so its concrete
   `infrastructure/adapters/*` imports are expected and exempt wholesale —
   mirrors node's `application/mode.ts`).
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

HERE = Path(__file__).resolve().parent
PACKAGE_ROOT = HERE.parent
SRC_ROOT = PACKAGE_ROOT / "src" / "fireweave"
DOMAIN_DIR = SRC_ROOT / "domain"
APPLICATION_DIR = SRC_ROOT / "application"


def test_pyproject_declares_zero_runtime_dependencies():
    manifest = tomllib.loads((PACKAGE_ROOT / "pyproject.toml").read_text())
    assert manifest["project"]["dependencies"] == [], (
        "the SDK must stay dependency-free: [project].dependencies must be []"
    )


def _walk_py_files(directory: Path):
    return sorted(p for p in directory.rglob("*.py") if "__pycache__" not in p.parts)


# Matches `from .foo import x`, `from ..foo import x`, `import foo`, etc. —
# any module-level import statement's dotted target.
_IMPORT_PATTERN = re.compile(r"^\s*(?:from\s+(\.+[\w.]*|\w[\w.]*)\s+import|import\s+(\.+[\w.]*|\w[\w.]*))", re.MULTILINE)


def _module_targets(text: str) -> list:
    targets = []
    for match in _IMPORT_PATTERN.finditer(text):
        target = match.group(1) or match.group(2)
        if target:
            targets.append(target)
    return targets


def test_domain_imports_nothing_from_application_or_infrastructure():
    files = _walk_py_files(DOMAIN_DIR)
    assert files, "expected source files under src/fireweave/domain"

    offenders = []
    for file in files:
        text = file.read_text()
        for target in _module_targets(text):
            # domain/ is entirely self-contained: every import must stay
            # inside domain/ — a same-level relative specifier (`.foo`), or
            # an absolute stdlib/typing import (no leading dot, doesn't name
            # `fireweave.*`). A relative import that walks up out of
            # domain/ (`..application`, `..infrastructure`) is exactly what
            # this guard exists to catch, as is any absolute
            # `fireweave.application`/`fireweave.infrastructure` import.
            walks_up = target.startswith("..")
            reaches_outer_absolute = target.startswith("fireweave.application") or target.startswith(
                "fireweave.infrastructure"
            )
            if walks_up or reaches_outer_absolute:
                offenders.append(f"{file.relative_to(DOMAIN_DIR)} imports {target!r}")

    assert offenders == [], f"domain/ must not depend on outer layers: {'; '.join(offenders)}"


# mode.py is the SANCTIONED composition root: the plan places "mode" in
# application/ and its defined job is adapter selection, so its concrete
# infrastructure/adapters/* imports are expected and exempt wholesale — it
# is skipped entirely below rather than allowlisted specifier-by-specifier.
APPLICATION_COMPOSITION_ROOT = "mode.py"


def test_application_outside_mode_py_does_not_import_infrastructure():
    files = _walk_py_files(APPLICATION_DIR)
    assert files, "expected source files under src/fireweave/application"

    offenders = []
    for file in files:
        rel = file.relative_to(APPLICATION_DIR)
        if rel.name == APPLICATION_COMPOSITION_ROOT:
            continue
        text = file.read_text()
        for target in _module_targets(text):
            if target.startswith("..infrastructure") or "fireweave.infrastructure" in target:
                offenders.append(f"{rel} imports {target!r}")

    assert offenders == [], (
        f"application/ (outside {APPLICATION_COMPOSITION_ROOT}) must not import "
        f"infrastructure/: {'; '.join(offenders)}"
    )


def test_mode_py_is_the_only_application_file_importing_infrastructure():
    """The flip side of the guard above: confirms the exemption is actually
    load-bearing (mode.py DOES import infrastructure/), not a dead carve-out
    for a boundary nothing crosses."""
    mode_text = (APPLICATION_DIR / "mode.py").read_text()
    targets = _module_targets(mode_text)
    assert any("infrastructure" in t for t in targets), (
        "mode.py is exempted as the composition root but imports no "
        "infrastructure/ module — the exemption is stale"
    )
