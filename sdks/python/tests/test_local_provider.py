"""Local dev provider — FLAG_NOT_FOUND rewrite + FireweaveLocalAdapter."""

from __future__ import annotations

import pytest
from openfeature import api
from openfeature.evaluation_context import EvaluationContext as OFContext
from openfeature.flag_evaluation import Reason

from fireweave import FireweaveLocalAdapter, FireweaveRuntime
from fireweave.context import EvaluationContext
from fireweave.errors import FlagNotFoundError
from fireweave.openfeature import (
    get_fw_local_captures,
    make_fireweave_local_provider,
    reset_fw_local_captures,
)
from fireweave.types import FlagType

CTX = OFContext(targeting_key="user_42")


@pytest.fixture(autouse=True)
def _clear_captures():
    reset_fw_local_captures()
    yield
    reset_fw_local_captures()


def _provider(**opts):
    p = make_fireweave_local_provider(**opts)
    p.initialize(OFContext())
    return p


class TestLocalProvider:
    def test_unknown_control_point_resolves_to_default_cleanly(self):
        p = _provider()
        d = p.resolve_boolean_details("fw-unconfigured", False, CTX)
        assert d.value is False
        assert d.reason == Reason.DEFAULT
        assert d.error_code is None
        assert d.variant == "default"

    def test_call_site_default_honoured(self):
        p = _provider()
        d = p.resolve_boolean_details("fw-unconfigured", True, CTX)
        assert d.value is True
        assert d.reason == Reason.DEFAULT
        assert d.error_code is None

    def test_dev_flags_true_static(self):
        p = _provider(dev_flags={"fw-checkout": True})
        d = p.resolve_boolean_details("fw-checkout", False, CTX)
        assert d.value is True
        assert d.reason == Reason.STATIC
        assert d.variant == "on"
        assert d.error_code is None

    def test_dev_flags_false_forces_off(self):
        p = _provider(dev_flags={"fw-checkout": False})
        d = p.resolve_boolean_details("fw-checkout", True, CTX)
        assert d.value is False
        assert d.reason == Reason.STATIC
        assert d.variant == "off"

    def test_string_integer_float_object_defaults(self):
        p = _provider()
        s = p.resolve_string_details("fw-copy", "fallback", CTX)
        n = p.resolve_integer_details("fw-limit", 7, CTX)
        f = p.resolve_float_details("fw-ratio", 0.5, CTX)
        o = p.resolve_object_details("fw-config", {"a": 1}, CTX)
        assert s.value == "fallback" and s.reason == Reason.DEFAULT and s.error_code is None
        assert n.value == 7 and n.reason == Reason.DEFAULT and n.error_code is None
        assert f.value == 0.5 and f.reason == Reason.DEFAULT and f.error_code is None
        assert o.value == {"a": 1} and o.reason == Reason.DEFAULT and o.error_code is None

    def test_captures_and_reset(self):
        p = _provider(dev_flags={"fw-on": True}, now=lambda: 1234.0)
        p.resolve_boolean_details("fw-on", False, CTX)
        p.resolve_string_details("fw-copy", "x", CTX)
        caps = get_fw_local_captures()
        assert len(caps) == 2
        assert [(c.flag_key, c.type, c.value, c.reason, c.ts) for c in caps] == [
            ("fw-on", "boolean", True, "STATIC", 1234.0),
            ("fw-copy", "string", "x", "DEFAULT", 1234.0),
        ]
        reset_fw_local_captures()
        assert len(get_fw_local_captures()) == 0

    def test_echo_prints_when_enabled(self, capsys):
        p = _provider(echo=True, dev_flags={"fw-on": True})
        p.resolve_boolean_details("fw-on", False, CTX)
        out = capsys.readouterr().out
        assert "[fw-local]" in out
        assert "fw-on" in out

    def test_echo_silent_by_default(self, capsys):
        p = _provider()
        p.resolve_boolean_details("fw-quiet", False, CTX)
        assert capsys.readouterr().out == ""

    def test_real_errors_not_rewritten(self):
        p = _provider()
        p.shutdown()
        d = p.resolve_boolean_details("fw-anything", False, CTX)
        assert d.reason == Reason.ERROR
        assert d.error_code is not None

    def test_openfeature_client(self):
        api.set_provider(
            make_fireweave_local_provider(dev_flags={"fw-on": True})
        )
        client = api.get_client()
        assert client.get_boolean_value("fw-on", False, CTX) is True
        assert client.get_boolean_value("fw-unconfigured", False, CTX) is False
        details = client.get_boolean_details("fw-unconfigured", True, CTX)
        assert details.value is True
        assert details.reason == Reason.DEFAULT
        assert details.error_code is None
        api.shutdown()


class TestLocalAdapter:
    def test_features(self):
        adapter = FireweaveLocalAdapter(dev_flags={"a": True})
        f = adapter.runtime_features()
        assert f["localOnly"] is True
        assert f["remoteEvaluation"] is False
        assert f["sideEffectFreeReads"] is True

    def test_miss_and_hit(self):
        adapter = FireweaveLocalAdapter(dev_flags={"fw-on": True})
        adapter.initialize()
        ctx = EvaluationContext(targeting_key="u")
        with pytest.raises(FlagNotFoundError):
            adapter.resolve("fw-missing", ctx)
        hit = adapter.resolve("fw-on", ctx)
        assert hit.matched is True
        assert hit.value is True
        assert hit.fireweave_reason == "STATIC"

    def test_composes_with_runtime(self):
        runtime = FireweaveRuntime(
            FireweaveLocalAdapter(dev_flags={"fw-on": True})
        )
        runtime.initialize()
        assert runtime.state.name == "READY"
        d = runtime.evaluate(
            "fw-on", FlagType.BOOLEAN, False, EvaluationContext(targeting_key="u")
        )
        assert d.value is True
        assert d.reason == "STATIC"
        runtime.shutdown()
