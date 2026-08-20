"""Vendor-leak / OpenFeature-provider-leak guard (spec/control-points.md
"Scope of v1": "An SDK MUST NOT expose them, and MUST NOT expose an
OpenFeature provider").

python's pre-v1 surface shipped `fireweave.adapters.posthog` (a direct
PostHog vendor adapter) and `fireweave.openfeature` (an OpenFeature provider
package); this task's cut removes both wholesale. This is the test that
keeps that cleanup from silently regressing — if it fails because a vendor
name or the provider package came back, the fix is to remove it again, not
to add an exemption here.
"""

from __future__ import annotations

import re
from pathlib import Path

import fireweave

HERE = Path(__file__).resolve().parent
SRC_ROOT = HERE.parent / "src" / "fireweave"

_VENDOR_PATTERN = re.compile(r"posthog", re.IGNORECASE)


def _walk_py_files(directory: Path):
    return sorted(p for p in directory.rglob("*.py") if "__pycache__" not in p.parts)


def test_no_export_name_references_a_backend_vendor():
    for name in dir(fireweave):
        assert not _VENDOR_PATTERN.search(name), f"unexpected vendor export: {name}"


def test_the_published_package_contains_no_vendor_reference_at_all():
    files = _walk_py_files(SRC_ROOT)
    assert files, "expected source files under src/fireweave"

    offenders = []
    for file in files:
        if _VENDOR_PATTERN.search(file.read_text()):
            offenders.append(str(file.relative_to(SRC_ROOT)))
    assert offenders == [], f"vendor reference leaked into: {', '.join(offenders)}"


def test_no_openfeature_provider_package():
    assert not (SRC_ROOT / "openfeature").exists(), (
        "the openfeature/ provider package was retired in the v1 cut and must not return"
    )
    assert not hasattr(fireweave, "openfeature")


def test_no_async_second_surface():
    """aio.py duplicated the pre-v1 surface (extension namespaces) and
    otherwise only thread-offloaded the sync client's control-point reads —
    no independent evaluation logic of its own. spec/control-points.md's
    documented python surface is synchronous methods on `control_points`
    (server SDK — blocking I/O is fine); this task does not build a second
    async surface."""
    assert not (SRC_ROOT / "aio.py").exists()
    assert not hasattr(fireweave, "AsyncFireweaveClient")
