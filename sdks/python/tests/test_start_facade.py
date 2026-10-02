"""Start profile: start(), the process singleton and the ``fw`` facade.
Local values, idempotency, implicit start, reads that never raise, status,
instance key, identify, shutdown, threads and fork.
"""

from __future__ import annotations

import inspect
import json
import logging
import os
import threading
from pathlib import Path

import pytest

from fireweave import ConfigurationError, ErrorKind, EvaluationContext, FireweaveClient, FlagType
from fireweave.start import define_flags, fw, start
from fireweave.start import _state

pytestmark = pytest.mark.usefixtures("start_profile")

KEY = "project-api-key_SENTINEL123"
URL = "https://fw.example.com"
DEV = {"FIREWEAVE_ENV": "development"}
CTX = EvaluationContext("user-1")

FLAGS = define_flags(
    {
        "new-checkout": {"local": True, "description": "One-page checkout"},
        "old-banner": {"local": False},
    }
)


def remote_transport(calls, value=True):
    def transport(url, body, headers, timeout):
        calls.append((url, body, headers))
        if url.endswith("/v1/targets/register"):
            return 200, {"ok": True}
        return 200, {
            "decisions": [
                {"flagKey": k, "value": value, "found": True, "enabled": True, "reason": "TARGETING_MATCH"}
                for k in body["flagKeys"]
            ]
        }

    return transport


class TestLocalMode:
    def test_serves_each_local_value_and_logs_one_local_line(self):
        lines = []
        start(flags=FLAGS, env=DEV, log=lines.append)
        assert fw.control_points.get_boolean_value("new-checkout", False, CTX) is True
        assert fw.control_points.get_boolean_value("old-banner", True, CTX) is False
        decision = fw.control_points.get_boolean_details("new-checkout", False, CTX)
        assert (decision.value, decision.reason) == (True, "STATIC")
        assert len([line for line in lines if "Local mode" in line]) == 1
        assert "Serving 2 flags" in lines[0]

    def test_a_key_missing_from_the_flags_object_gets_its_default_and_warns_once_naming_the_file(self):
        lines = []
        start(flags=FLAGS, env=DEV, log=lines.append)
        assert fw.control_points.get_boolean_value("not-declared", False, CTX) is False
        assert fw.control_points.get_boolean_value("not-declared", False, CTX) is False
        warnings = [line for line in lines if "'not-declared' is not in your flags object" in line]
        assert len(warnings) == 1
        assert Path(__file__).name in warnings[0]

    def test_mode_local_works_with_no_environment_name(self):
        start(flags=FLAGS, mode="local", env={})
        assert fw.control_points.get_boolean_value("new-checkout", False, CTX) is True
        assert fw.status().mode_source == "option"

    def test_the_inferred_local_banner_is_a_warning_on_the_fireweave_start_logger(self, caplog):
        caplog.set_level(logging.INFO, logger="fireweave.start")
        start(flags=FLAGS, env=DEV)
        banner = [r for r in caplog.records if "Local mode" in r.getMessage()]
        assert [r.levelno for r in banner] == [logging.WARNING]

    def test_a_logger_can_be_the_log_sink(self, caplog):
        caplog.set_level(logging.INFO, logger="app.flags")
        start(flags=FLAGS, mode="local", env={}, log=logging.getLogger("app.flags"))
        assert any("Local mode" in r.getMessage() for r in caplog.records if r.name == "app.flags")


class TestIdempotency:
    def test_a_second_identical_start_is_a_no_op(self):
        start(flags=FLAGS, env=DEV)
        client = fw.client()
        start(flags=FLAGS, env=DEV)
        assert fw.client() is client

    def test_a_second_start_with_different_flags_raises_configuration(self):
        start(flags=FLAGS, env=DEV)
        with pytest.raises(ConfigurationError, match="already called with a different configuration"):
            start(flags={"new-checkout": {"local": False}}, env=DEV)

    def test_a_different_key_is_a_conflict_and_the_log_sink_is_not_part_of_the_check(self):
        start(key=KEY, env={}, log=lambda line: None)
        start(key=KEY, env={}, log=print)
        with pytest.raises(ConfigurationError) as info:
            start(key="project-api-key_other", env={})
        assert KEY not in info.value.message

    def test_flags_do_not_count_in_remote_mode(self):
        start(key=KEY, env={})
        start(key=KEY, env={}, flags=FLAGS)

    def test_the_first_start_keeps_its_log_sink(self):
        first, second = [], []
        start(flags=FLAGS, env=DEV, log=first.append)
        start(flags=FLAGS, env=DEV, log=second.append)
        fw.control_points.get_boolean_value("undeclared", False, CTX)
        assert any("undeclared" in line for line in first)
        assert second == []

    def test_bad_config_raises_from_start_itself_and_changes_nothing(self):
        with pytest.raises(ConfigurationError):
            start(env={"APP_ENV": "production"})
        assert fw.status().state == "unstarted"

    def test_options_are_keyword_only(self):
        with pytest.raises(TypeError):
            start(FLAGS)  # type: ignore[misc]
        params = inspect.signature(start).parameters.values()
        assert all(p.kind is p.KEYWORD_ONLY for p in params)
        assert [p.name for p in params][:8] == [
            "flags", "mode", "environment", "url", "key", "instance_id", "env", "log",
        ]

    @pytest.mark.parametrize(
        "kwargs, fragment",
        [({"log": 3}, "start(log=...)"), ({"env": "x"}, "start(env=...)"), ({"instance_id": 3}, "start(instance_id=...)")],
    )
    def test_bad_option_types_raise_configuration(self, kwargs, fragment):
        with pytest.raises(ConfigurationError, match=fragment.replace("(", r"\(").replace(")", r"\)")):
            start(**{"env": DEV, **kwargs})


class TestImplicitStart:
    def test_with_no_start_fireweave_starts_from_the_process_environment(self, monkeypatch, caplog):
        monkeypatch.setenv("FIREWEAVE_ENV", "development")
        caplog.set_level(logging.WARNING, logger="fireweave.start")
        assert fw.control_points.get_boolean_value("anything", True, CTX) is True
        status = fw.status()
        assert (status.state, status.started_by, status.mode) == ("ready", "implicit", "local")
        implicit = [r for r in caplog.records if "read before start() ran" in r.getMessage()]
        assert len(implicit) == 1 and implicit[0].levelno == logging.WARNING

    def test_the_first_explicit_start_replaces_an_implicit_one_once(self, monkeypatch):
        monkeypatch.setenv("FIREWEAVE_ENV", "development")
        lines = []
        captured = fw.control_points
        assert captured.get_boolean_value("new-checkout", False, CTX) is False  # implicit: no flags
        provisional = fw.client()
        start(flags=FLAGS, log=lines.append)
        assert captured.get_boolean_value("new-checkout", False, CTX) is True
        assert fw.client() is not provisional
        assert any("replaced the configuration" in line for line in lines)
        # The replaced client is not shut down: a captured reference still reads.
        assert provisional.control_points.get_boolean_details("x", False, CTX).error_kind is None
        assert fw.status().started_by == "explicit"
        with pytest.raises(ConfigurationError):
            start(flags={"other": {"local": True}})

    def test_an_identical_explicit_start_adopts_the_implicit_one(self, monkeypatch):
        monkeypatch.setenv("FIREWEAVE_ENV", "development")
        lines = []
        fw.control_points.get_boolean_value("x", False, CTX)
        provisional = fw.client()
        start(log=lines.append)
        assert fw.client() is provisional
        assert not any("replaced" in line for line in lines)
        assert fw.status().started_by == "explicit"

    def test_a_failed_implicit_start_serves_defaults_and_errors_never_raises(self, caplog):
        caplog.set_level(logging.WARNING, logger="fireweave.start")
        assert fw.control_points.get_boolean_value("x", True, CTX) is True
        assert fw.control_points.get_string_value("x", "d", CTX) == "d"
        assert fw.control_points.get_number_value("x", 3, CTX) == 3
        assert fw.control_points.get_object_value("x", {"a": 1}, CTX) == {"a": 1}
        for decision in (
            fw.control_points.get_boolean_details("x", False, CTX),
            fw.control_points.get_string_details("x", "d", CTX),
            fw.control_points.get_number_details("x", 1, CTX),
            fw.control_points.get_object_details("x", [], CTX),
            fw.control_points.evaluate("x", FlagType.BOOLEAN, False, CTX),
        ):
            assert decision.reason == "ERROR"
            assert decision.error_kind is ErrorKind.CONFIGURATION
            assert "FIREWEAVE_KEY" in decision.error_message
            assert decision.flag_metadata == {"fireweave.errorKind": "Configuration"}
        result = fw.identify("user-1")
        assert result.ok is False and result.error.kind is ErrorKind.CONFIGURATION
        status = fw.status()
        assert status.state == "failed" and "FIREWEAVE_KEY" in status.error
        errors = [r for r in caplog.records if r.levelno == logging.ERROR]
        assert len(errors) == 1 and "reads serve their defaults" in errors[0].getMessage()

    def test_an_explicit_start_recovers_after_a_failed_implicit_start(self):
        assert fw.control_points.get_boolean_value("new-checkout", False, CTX) is False
        start(flags=FLAGS, env=DEV)
        assert fw.control_points.get_boolean_value("new-checkout", False, CTX) is True
        assert fw.status().state == "ready"

    def test_eight_threads_racing_the_first_read_get_one_client(self, monkeypatch):
        monkeypatch.setenv("FIREWEAVE_ENV", "test")
        barrier = threading.Barrier(8)
        clients = []

        def first_read():
            barrier.wait()
            fw.control_points.get_boolean_value("x", False, CTX)
            clients.append(fw.client())

        threads = [threading.Thread(target=first_read) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert len({id(c) for c in clients}) == 1


class TestReadsNeverRaise:
    def test_a_dict_context_is_an_invalid_context_not_an_exception(self):
        start(flags=FLAGS, env=DEV)
        assert fw.control_points.get_boolean_value("new-checkout", False, {"targeting_key": "u"}) is False
        decision = fw.control_points.get_boolean_details("new-checkout", False, {"targeting_key": "u"})
        assert decision.reason == "ERROR" and decision.error_kind is ErrorKind.INVALID_CONTEXT

    def test_bad_keys_and_defaults_serve_the_default(self):
        start(flags=FLAGS, env=DEV)
        assert fw.control_points.get_boolean_value(None, False, CTX) is False  # type: ignore[arg-type]
        assert fw.control_points.get_boolean_details("new-checkout", "nope", CTX).error_kind is ErrorKind.TYPE_MISMATCH

    def test_a_broken_log_sink_never_breaks_a_read(self):
        def broken(line):
            raise RuntimeError("sink down")

        start(flags=FLAGS, env=DEV, log=broken)
        assert fw.control_points.get_boolean_value("undeclared", True, CTX) is True

    def test_an_auth_failure_in_remote_mode_is_a_default_and_a_decision(self):
        start(key=KEY, url=URL, env={}, transport=lambda *a: (401, {"ok": False}))
        assert fw.control_points.get_boolean_value("x", False, CTX) is False
        assert fw.control_points.get_boolean_details("x", False, CTX).error_kind is ErrorKind.AUTHENTICATION


class TestRemoteThroughTransport:
    def test_reads_and_identify_go_to_the_configured_endpoint_with_the_key(self):
        calls = []
        start(key=KEY, url=URL, env={}, flags={"x": {"local": False}}, transport=remote_transport(calls))
        assert fw.control_points.get_boolean_value("x", False, CTX) is True  # flags ignored in remote
        assert fw.identify("user-1", {"plan": "pro"}, kind="user").ok is True
        assert calls[0][0] == f"{URL}/v1/flags/evaluate"
        assert calls[0][2]["Authorization"] == f"Bearer {KEY}"
        assert calls[1][0] == f"{URL}/v1/targets/register"
        assert calls[1][1] == {"targetingKey": "user-1", "kind": "user", "properties": {"plan": "pro"}}

    def test_a_key_missing_from_flags_does_not_warn_in_remote_mode(self):
        lines = []
        start(key=KEY, url=URL, env={}, log=lines.append, transport=remote_transport([]))
        fw.control_points.get_boolean_value("undeclared", False, CTX)
        assert lines == []


class TestStatus:
    def test_status_reports_the_decision_and_never_the_key(self):
        start(key=KEY, url=URL, env={"FIREWEAVE_INSTANCE_ID": "i"}, transport=remote_transport([]))
        status = fw.status()
        assert (status.mode, status.mode_source, status.key_source) == ("remote", "key", "start(key=...)")
        assert (status.host, status.endpoint_source) == ("fw.example.com", "start(url=...)")
        assert status.channel in ("production", "staging") and status.sdk_version
        assert status.flag_count == 0 and status.error is None
        assert "SENTINEL" not in repr(status) and "SENTINEL" not in repr(fw)
        assert "SENTINEL" not in json.dumps(status.__dict__)

    def test_status_before_start(self):
        status = fw.status()
        assert status.state == "unstarted" and status.mode is None and status.started_by is None

    def test_a_legacy_key_name_warns_once_and_never_prints_the_value(self):
        lines = []
        start(env={"FW_PROJECT_API_KEY": KEY}, log=lines.append, transport=remote_transport([]))
        assert fw.status().key_source == "FW_PROJECT_API_KEY"
        assert len([line for line in lines if "legacy name" in line]) == 1
        assert not any("SENTINEL" in line for line in lines)


class TestInstanceKey:
    def test_the_option_wins(self):
        start(flags=FLAGS, env={**DEV, "FIREWEAVE_INSTANCE_ID": "env-id"}, instance_id="checkout-api")
        assert fw.instance_key() == "checkout-api"

    def test_then_fireweave_instance_id(self):
        start(flags=FLAGS, env={**DEV, "FIREWEAVE_INSTANCE_ID": "env-id"})
        assert fw.instance_key() == "env-id"

    def test_then_a_hash_of_the_host_name_stable_within_the_process(self, monkeypatch):
        from fireweave.start._instance import fnv1a64

        monkeypatch.setattr(_state, "host_name", lambda: "web-1")
        start(flags=FLAGS, env=DEV)
        assert fw.instance_key() == f"inst_{fnv1a64('web-1')}"
        assert fw.instance_key() == fw.instance_key()

    def test_fnv1a64_matches_the_node_profile(self):
        from fireweave.start._instance import fnv1a64

        # FNV-1a 64 reference vectors.
        assert fnv1a64("") == "cbf29ce484222325"
        assert fnv1a64("a") == "af63dc4c8601ec8c"

    def test_then_a_random_id_when_the_host_will_not_say(self, monkeypatch):
        monkeypatch.setattr(_state, "host_name", lambda: None)
        key = fw.instance_key()
        assert key.startswith("inst_") and len(key) == 37
        assert fw.instance_key() == key

    def test_before_start_it_reads_the_process_environment_and_never_starts(self, monkeypatch):
        monkeypatch.setenv("FIREWEAVE_INSTANCE_ID", "from-env")
        assert fw.instance_key() == "from-env"
        assert fw.status().state == "unstarted"

    def test_an_instance_id_that_differs_from_one_already_handed_out_is_a_conflict(self, monkeypatch):
        monkeypatch.setattr(_state, "host_name", lambda: "web-1")
        fw.instance_key()
        with pytest.raises(ConfigurationError, match="instance_key"):
            start(flags=FLAGS, env=DEV, instance_id="other")


class TestIdentify:
    def test_identify_registers_a_user_target_locally(self):
        lines = []
        start(flags=FLAGS, env=DEV, log=lines.append)
        result = fw.identify("user-1", {"plan": "pro"})
        assert result.ok is True
        assert any("registerTarget user user-1" in line for line in lines)

    def test_kind_is_keyword_only_and_passed_through(self):
        lines = []
        start(flags=FLAGS, env=DEV, log=lines.append)
        assert fw.identify("device-9", kind="device").ok is True
        assert any("registerTarget device device-9" in line for line in lines)
        assert inspect.signature(fw.identify).parameters["kind"].kind is inspect.Parameter.KEYWORD_ONLY

    def test_identify_never_raises(self):
        start(flags=FLAGS, env=DEV, log=lambda line: None)
        result = fw.identify("user-1", {"when": object()})  # not JSON
        assert result.ok is False and result.error is not None


class TestShutdown:
    def test_after_shutdown_reads_serve_defaults_and_start_begins_again(self):
        start(flags=FLAGS, env=DEV)
        fw.shutdown()
        assert fw.status().state == "shutdown"
        assert fw.control_points.get_boolean_value("new-checkout", False, CTX) is False
        assert fw.control_points.get_boolean_details("new-checkout", False, CTX).error_kind is ErrorKind.ALREADY_CLOSED
        start(flags=FLAGS, env=DEV)
        assert fw.control_points.get_boolean_value("new-checkout", False, CTX) is True

    def test_shutdown_before_start_is_harmless(self):
        fw.shutdown()
        assert fw.status().state == "unstarted"


class TestFacadeSurface:
    DESCRIPTOR = json.loads(
        (Path(__file__).resolve().parents[3] / "conformance" / "surface" / "control-points.surface.json").read_text()
    )
    SNAKE = {
        "getBooleanValue": "get_boolean_value",
        "getStringValue": "get_string_value",
        "getNumberValue": "get_number_value",
        "getObjectValue": "get_object_value",
        "getBooleanDetails": "get_boolean_details",
        "getStringDetails": "get_string_details",
        "getNumberDetails": "get_number_details",
        "getObjectDetails": "get_object_details",
        "evaluate": "evaluate",
    }

    def test_control_points_has_exactly_the_cores_nine_methods_with_the_same_arities(self):
        public = sorted(n for n in dir(fw.control_points) if not n.startswith("_"))
        assert public == sorted(self.SNAKE.values())
        for method in self.DESCRIPTOR["methods"]:
            fn = getattr(fw.control_points, self.SNAKE[method["name"]])
            assert len(inspect.signature(fn).parameters) == len(method["args"]), method["name"]

    def test_the_facade_matches_the_core_parameter_names(self):
        from fireweave import FireweaveRuntime, InMemoryAdapter

        core = FireweaveClient(FireweaveRuntime(InMemoryAdapter({}))).control_points
        for name in self.SNAKE.values():
            assert list(inspect.signature(getattr(fw.control_points, name)).parameters) == list(
                inspect.signature(getattr(core, name)).parameters
            ), name

    def test_fw_is_read_only(self):
        with pytest.raises(AttributeError):
            fw.control_points = None  # type: ignore[misc]


@pytest.mark.skipif(not hasattr(os, "fork"), reason="POSIX only")
class TestFork:
    def _in_child(self, body) -> int:
        pid = os.fork()
        if pid == 0:  # pragma: no cover - runs in the child
            code = 1
            try:
                code = 0 if body() else 2
            finally:
                os._exit(code)
        _, status = os.waitpid(pid, 0)
        return os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else status >> 8

    def test_the_child_rebuilds_its_client_and_reads(self):
        start(flags=FLAGS, env=DEV)
        parent_client = fw.client()

        def child():
            return fw.client() is not parent_client and fw.control_points.get_boolean_value("new-checkout", False, CTX)

        assert self._in_child(child) == 0

    def test_a_runtime_lock_held_at_fork_does_not_block_the_child(self):
        start(flags=FLAGS, env=DEV)
        runtime_lock = fw.client().runtime._lock
        held, release = threading.Event(), threading.Event()

        def hold():
            with runtime_lock:
                held.set()
                release.wait(5)

        holder = threading.Thread(target=hold)
        holder.start()
        held.wait(5)
        try:
            assert self._in_child(lambda: fw.control_points.get_boolean_value("new-checkout", False, CTX)) == 0
        finally:
            release.set()
            holder.join()
