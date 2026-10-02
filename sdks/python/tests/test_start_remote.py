"""Integration: the start profile in remote mode against the Fireweave
protocol stub (test-server/implementation/server.mjs), over real HTTP.

The stub is started with ``fireweaveApiKey`` so it accepts only the project
key under test, which proves the key start() resolved is the one sent.
Skipped when node is not installed.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from fireweave import ErrorKind, EvaluationContext
from fireweave.start import fw, start

pytestmark = pytest.mark.usefixtures("start_profile")

REPO_ROOT = Path(__file__).resolve().parents[3]
SERVER = REPO_ROOT / "test-server" / "implementation" / "server.mjs"
KEY = "project-api-key_integration"
CTX = EvaluationContext("user-1")

_BOOT = """
import { startTestServer } from %s;
const server = await startTestServer({ port: 0, fireweaveApiKey: %s });
process.stdout.write(server.url + "\\n");
process.stdin.resume();
process.stdin.on("end", () => server.close().then(() => process.exit(0)));
"""


@pytest.fixture(scope="module")
def server_url():
    node = shutil.which("node")
    if node is None or not SERVER.exists():
        pytest.skip("node or test-server is unavailable")
    script = _BOOT % (json.dumps(SERVER.as_uri()), json.dumps(KEY))
    proc = subprocess.Popen(
        [node, "--input-type=module", "-e", script],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    try:
        url = proc.stdout.readline().strip()
        if not url.startswith("http://"):
            pytest.skip("test-server did not start")
        yield url
    finally:
        proc.stdin.close()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def test_a_key_plus_a_custom_endpoint_evaluates_over_the_wire(server_url):
    start(
        key=KEY,
        url=server_url,
        env={"APP_ENV": "production"},
        flags={"fw-bool-on": {"local": False}},
        log=lambda line: None,
    )
    # The stub says on; the local value (False) is ignored in remote mode.
    assert fw.control_points.get_boolean_value("fw-bool-on", False, CTX) is True
    assert fw.control_points.get_string_value("fw-string-theme", "light", CTX) == "dark"
    status = fw.status()
    assert (status.mode, status.endpoint_source, status.host) == ("remote", "start(url=...)", "127.0.0.1")


def test_the_key_is_read_from_fireweave_key(server_url):
    start(env={"FIREWEAVE_KEY": KEY, "FIREWEAVE_URL": server_url}, log=lambda line: None)
    assert fw.control_points.get_boolean_value("fw-bool-on", False, CTX) is True
    assert fw.status().key_source == "FIREWEAVE_KEY"


def test_a_wrong_key_never_raises_from_a_read(server_url):
    start(key="project-api-key_wrong", url=server_url, env={}, log=lambda line: None)
    decision = fw.control_points.get_boolean_details("fw-bool-on", False, CTX)
    assert (decision.value, decision.reason, decision.error_kind) == (False, "ERROR", ErrorKind.AUTHENTICATION)
