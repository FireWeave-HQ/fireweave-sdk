"""SP-27: when fw-server refuses the key (401/403), rate-limits (429) or cannot
be reached, the start profile logs ONE line per kind for the life of the
process, naming the key's source or the endpoint and the host but never the
key, and ``fw.status().last_error_kind`` holds the latest kind. A revoked key
must not look like a rollout at 0%. Through an injected transport; the real
HTTP case is in test_start_remote.py."""

from __future__ import annotations

import logging

import pytest

from fireweave import ErrorKind, EvaluationContext, NetworkError, TimeoutError_
from fireweave.start import fw, start

pytestmark = pytest.mark.usefixtures("start_profile")

KEY = "project-api-key_SENTINEL987"
URL = "https://fw.example.com"
ENV = {"FIREWEAVE_KEY": KEY, "FIREWEAVE_URL": URL}
CTX = EvaluationContext("user-1")


def answering(*answers):
    """A transport that answers each call with the next item: a status code
    (with an empty body), an exception to raise, or 'ok'."""
    queue = list(answers)

    def transport(url, body, headers, timeout):
        answer = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(answer, BaseException):
            raise answer
        if answer == "ok":
            if url.endswith("/v1/targets/register"):
                return 200, {"ok": True}
            return 200, {"decisions": [{"controlPointKey": k, "value": True, "found": True} for k in body["controlPointKeys"]]}
        return answer, {}

    return transport


def _read_a_few_times():
    for _ in range(3):
        fw.control_points.get_boolean_value("x", False, CTX)
        fw.control_points.get_boolean_details("x", False, CTX)
        fw.identify("user-1")


def test_a_rejected_key_logs_one_line_naming_fireweave_key_and_never_the_key():
    lines = []
    start(env=ENV, log=lines.append, transport=answering(401))
    assert fw.status().last_error_kind is None
    _read_a_few_times()
    assert len(lines) == 1, lines
    assert "FIREWEAVE_KEY" in lines[0] and "fw.example.com" in lines[0] and "401" in lines[0]
    assert "SENTINEL" not in lines[0] and KEY not in lines[0]
    status = fw.status()
    assert status.last_error_kind == "Authentication"
    assert "SENTINEL" not in repr(status)


def test_the_line_never_holds_a_key_the_redactor_would_not_recognise():
    # Not key-shaped, so only the line's own wording keeps it out.
    plain = "plainSENTINEL4242"
    lines = []
    start(env={"FIREWEAVE_KEY": plain, "FIREWEAVE_URL": URL}, log=lines.append, transport=answering(401))
    fw.control_points.get_boolean_value("x", False, CTX)
    assert len(lines) == 1 and "FIREWEAVE_KEY" in lines[0] and "SENTINEL" not in lines[0]


def test_the_line_names_the_option_when_the_key_came_from_start():
    lines = []
    start(key=KEY, url=URL, env={}, log=lines.append, transport=answering(403))
    fw.control_points.get_boolean_value("x", False, CTX)
    assert len(lines) == 1 and "start(key=...)" in lines[0] and "403" in lines[0]
    assert "SENTINEL" not in lines[0]
    assert fw.status().last_error_kind == "Authorization"


@pytest.mark.parametrize(
    ("answer", "kind", "names"),
    [
        (401, "Authentication", "FIREWEAVE_KEY"),
        (403, "Authorization", "FIREWEAVE_KEY"),
        (429, "RateLimited", "FIREWEAVE_KEY"),
        (503, "BackendUnavailable", "FIREWEAVE_URL"),
        (NetworkError(), "Network", "FIREWEAVE_URL"),
        (TimeoutError_(), "Timeout", "FIREWEAVE_URL"),
    ],
    ids=["401", "403", "429", "503", "network", "timeout"],
)
def test_each_kind_logs_once_and_sets_last_error_kind(answer, kind, names):
    lines = []
    start(env=ENV, log=lines.append, transport=answering(answer))
    _read_a_few_times()
    assert len(lines) == 1 and names in lines[0] and "fw.example.com" in lines[0], lines
    assert "SENTINEL" not in lines[0]
    assert fw.status().last_error_kind == kind


def test_one_line_per_kind_and_last_error_kind_is_the_latest():
    lines = []
    start(env=ENV, log=lines.append, transport=answering(401, 401, 429, 503, NetworkError(), 401, "ok"))
    for _ in range(8):
        fw.control_points.get_boolean_value("x", False, CTX)
    # 401, 429 and one 'could not reach' line for 503 + Network.
    assert len(lines) == 3, lines
    assert ["401" in lines[0], "429" in lines[1], "Could not reach" in lines[2]] == [True, True, True]
    # The latest failure stays reported after a success.
    assert fw.control_points.get_boolean_value("x", False, CTX) is True
    assert fw.status().last_error_kind == "Authentication"


def test_a_rejected_key_is_an_error_on_the_default_logger(caplog):
    caplog.set_level(logging.WARNING, logger="fireweave.start")
    start(env=ENV, transport=answering(401))
    fw.control_points.get_boolean_value("x", False, CTX)
    fw.control_points.get_boolean_value("x", False, CTX)
    records = [r for r in caplog.records if "rejected the key" in r.getMessage()]
    assert len(records) == 1 and records[0].levelno == logging.ERROR


def test_errors_that_are_not_fw_server_failures_are_not_reported():
    lines = []
    start(env=ENV, log=lines.append, transport=answering("ok"))
    fw.control_points.get_boolean_details("x", "not a bool", CTX)  # TypeMismatch
    fw.control_points.get_boolean_details("x", False, {"targeting_key": "u"})  # InvalidContext
    assert lines == [] and fw.status().last_error_kind is None


def test_a_success_reports_nothing():
    lines = []
    start(env=ENV, log=lines.append, transport=answering("ok"))
    assert fw.control_points.get_boolean_value("x", False, CTX) is True
    assert fw.identify("user-1").ok is True
    assert lines == [] and fw.status().last_error_kind is None


def test_the_once_per_process_lines_survive_a_new_start_but_last_error_kind_does_not():
    lines = []
    start(env=ENV, log=lines.append, transport=answering(401))
    fw.control_points.get_boolean_value("x", False, CTX)
    fw.shutdown()
    start(env=ENV, log=lines.append, transport=answering(401))
    assert fw.status().last_error_kind is None
    fw.control_points.get_boolean_value("x", False, CTX)
    assert len(lines) == 1
    assert fw.status().last_error_kind == ErrorKind.AUTHENTICATION.value
