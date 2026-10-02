"""Layering and portability guards for the start profile
(docs/adr/0011-start-profile.md, "Consequences").

 - the core (everything under src/fireweave/ outside start/) never imports
   fireweave.start, and ``import fireweave`` does not load it;
 - start/ is built on the public ``fireweave`` API only: it imports the
   top-level package (names in ``fireweave.__all__``), its own modules and
   the standard library, never application/, domain/ or infrastructure/;
 - the process environment (``os.environ``, ``os.getenv`` and friends) and
   the host name are read in exactly one file, start/_env.py: the core still
   reads no environment (spec/modes.md);
 - start/ starts no thread.

AST-based, so a docstring that merely names ``os.environ`` is not a read.
Kept out of test_architecture_layers.py because that module imports tomllib
(3.11+) at import time.
"""

from __future__ import annotations

import ast
import subprocess
import sys
from pathlib import Path

import fireweave

HERE = Path(__file__).resolve().parent
SRC_ROOT = HERE.parent / "src" / "fireweave"
START_DIR = SRC_ROOT / "start"
ENV_SEAM = START_DIR / "_env.py"

_ENV_NAMES = {"environ", "environb", "getenv", "getenvb", "putenv", "unsetenv"}
_HOST_NAMES = {"gethostname", "getfqdn", "uname", "node"}


def _py_files(directory: Path):
    return sorted(p for p in directory.rglob("*.py") if "__pycache__" not in p.parts)


def _core_files():
    return [p for p in _py_files(SRC_ROOT) if START_DIR not in p.parents]


def _module_name(file: Path) -> list:
    parts = list(file.relative_to(SRC_ROOT.parent).with_suffix("").parts)
    return parts[:-1] if parts[-1] == "__init__" else parts


def _imports(file: Path):
    """Yield every imported module as an absolute dotted name, including a
    ``from X import y`` target's ``X.y`` (y may be a submodule)."""
    tree = ast.parse(file.read_text(), filename=str(file))
    package = _module_name(file) if file.name == "__init__.py" else _module_name(file)[:-1]
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield node, alias.name
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = package[: len(package) - (node.level - 1)]
                module = ".".join(base + ([node.module] if node.module else []))
            else:
                module = node.module or ""
            yield node, module
            for alias in node.names:
                yield node, f"{module}.{alias.name}"


def test_the_core_never_imports_the_start_profile():
    files = _core_files()
    assert files, "expected core source files"
    offenders = [
        f"{file.relative_to(SRC_ROOT)}:{node.lineno} imports {name}"
        for file in files
        for node, name in _imports(file)
        if name == "fireweave.start" or name.startswith("fireweave.start.")
    ]
    assert offenders == [], f"the core must not import fireweave.start: {'; '.join(offenders)}"


def test_importing_fireweave_does_not_load_the_start_profile():
    code = "import sys, fireweave; assert 'fireweave.start' not in sys.modules, sorted(sys.modules)"
    subprocess.run([sys.executable, "-c", code], check=True)


def test_start_imports_only_the_public_fireweave_api_its_own_modules_and_the_stdlib():
    files = _py_files(START_DIR)
    assert files, "expected source files under src/fireweave/start"
    public = set(fireweave.__all__)
    offenders = []
    for file in files:
        tree = ast.parse(file.read_text(), filename=str(file))
        for node in ast.walk(tree):
            where = f"{file.relative_to(SRC_ROOT)}:{getattr(node, 'lineno', '?')}"
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.startswith("fireweave."):
                        offenders.append(f"{where} imports {alias.name}")
            elif isinstance(node, ast.ImportFrom):
                if node.level > 1:
                    offenders.append(f"{where} walks up out of start/ ({'.' * node.level}{node.module or ''})")
                elif node.level == 0 and (node.module or "").startswith("fireweave."):
                    offenders.append(f"{where} imports {node.module}")
                elif node.level == 0 and node.module == "fireweave":
                    for alias in node.names:
                        if alias.name not in public:
                            offenders.append(f"{where} imports fireweave.{alias.name}, which is not in fireweave.__all__")
    assert offenders == [], f"start/ must use the public fireweave API only: {'; '.join(offenders)}"


def _env_and_host_reads(file: Path):
    tree = ast.parse(file.read_text(), filename=str(file))
    # Every local name bound to os/socket/platform (`import os as _os` included).
    modules = {"os": "os", "socket": "socket", "platform": "platform"}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in ("os", "socket", "platform"):
                    modules[alias.asname or alias.name] = alias.name
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id in modules:
            module = modules[node.value.id]
            if module == "os" and node.attr in _ENV_NAMES:
                yield node.lineno, f"os.{node.attr}"
            if node.attr in _HOST_NAMES:
                yield node.lineno, f"{module}.{node.attr}"
        elif isinstance(node, ast.ImportFrom) and node.module in ("os", "socket", "platform"):
            for alias in node.names:
                if alias.name in _ENV_NAMES | _HOST_NAMES:
                    yield node.lineno, f"from {node.module} import {alias.name}"


def test_the_environment_and_host_name_are_read_only_in_the_env_seam():
    offenders = [
        f"{file.relative_to(SRC_ROOT)}:{line} reads {what}"
        for file in _py_files(SRC_ROOT)
        if file != ENV_SEAM
        for line, what in _env_and_host_reads(file)
    ]
    assert offenders == [], (
        "only fireweave/start/_env.py may read the environment or the host name "
        f"(spec/modes.md: the core reads no environment): {'; '.join(offenders)}"
    )


def test_the_env_seam_exemption_is_load_bearing():
    reads = {what for _, what in _env_and_host_reads(ENV_SEAM)}
    assert "os.environ" in reads and "socket.gethostname" in reads, (
        "start/_env.py is exempted as the env seam but reads neither the environment nor the host name"
    )


def test_start_starts_no_thread():
    offenders = []
    for file in _py_files(START_DIR):
        for node in ast.walk(ast.parse(file.read_text(), filename=str(file))):
            if isinstance(node, ast.Attribute) and node.attr in ("Thread", "Timer") and getattr(node.value, "id", "") == "threading":
                offenders.append(f"{file.relative_to(SRC_ROOT)}:{node.lineno} uses threading.{node.attr}")
            if isinstance(node, ast.ImportFrom) and node.module == "threading":
                offenders += [
                    f"{file.relative_to(SRC_ROOT)}:{node.lineno} imports threading.{a.name}"
                    for a in node.names
                    if a.name in ("Thread", "Timer")
                ]
    assert offenders == [], f"start/ must not start threads: {'; '.join(offenders)}"


def test_importing_the_start_profile_reads_no_env_and_creates_no_logger():
    code = "\n".join(
        [
            "import logging, os",
            "class _Refuse(dict):",
            "    def _boom(self, *a, **k): raise AssertionError('env read at import: %r' % (a,))",
            "    __getitem__ = get = __contains__ = keys = items = copy = _boom",
            "real, os.environ = os.environ, _Refuse()",
            "import fireweave.start",
            "os.environ = real",
            "assert 'fireweave.start' not in logging.Logger.manager.loggerDict",
        ]
    )
    subprocess.run([sys.executable, "-c", code], check=True)
