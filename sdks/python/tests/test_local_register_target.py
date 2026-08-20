"""Local-mode target registration (spec/modes.md "registerTarget in local
mode").

This reverses an earlier design in which the local adapter reported
`UnsupportedCapability`. That existed to stop a dev harness *silently*
looking registered — a developer believing their targeting works because
nothing objected, with the first evidence otherwise arriving in production.

Recording plus an explicit trace keeps that guarantee by a different route:
nothing is silent, and local dev can exercise targeting rules offline. These
tests pin both halves — the recording AND the trace — because dropping the
trace would restore exactly the failure the old design was avoiding.
"""

from __future__ import annotations

from fireweave import (
    FireweaveClient,
    FireweaveLocalAdapter,
    FireweaveRuntime,
    RegisterTargetOptions,
    init_fireweave,
)


def harness():
    lines = []
    adapter = FireweaveLocalAdapter(log=lines.append)
    return adapter, lines


def test_records_the_target_instead_of_reporting_unsupported_capability():
    adapter, _lines = harness()
    runtime = FireweaveRuntime(adapter)
    runtime.initialize()

    result = runtime.register_target(
        "user_42", RegisterTargetOptions(kind="user", properties={"plan": "pro"})
    )

    assert result.ok is True
    assert result.error is None

    recorded = adapter.get_registered_targets()[0]
    assert recorded.targeting_key == "user_42"
    assert recorded.kind == "user"
    assert recorded.properties == {"plan": "pro"}


def test_traces_the_call_naming_local_mode_and_that_nothing_was_sent():
    adapter, lines = harness()
    runtime = FireweaveRuntime(adapter)
    runtime.initialize()
    runtime.register_target("user_7", RegisterTargetOptions(properties={"beta": True}))

    assert len(lines) == 1
    line = lines[0]
    # Naming the mode is what makes a stray line in a production log a
    # signal that something booted locally by mistake.
    assert "[fireweave:local]" in line
    assert "user_7" in line
    assert "NOT sent to fw-server" in line


def test_kind_defaults_to_user_and_properties_are_copied_not_aliased():
    adapter, _lines = harness()
    runtime = FireweaveRuntime(adapter)
    runtime.initialize()

    properties = {"plan": "free"}
    runtime.register_target("user_9", RegisterTargetOptions(properties=properties))
    properties["plan"] = "mutated-after-the-call"

    recorded = adapter.get_registered_targets()[0]
    assert recorded.kind == "user"
    assert recorded.properties == {"plan": "free"}


def test_reregistering_the_same_key_updates_rather_than_duplicating():
    adapter, _lines = harness()
    runtime = FireweaveRuntime(adapter)
    runtime.initialize()

    runtime.register_target("user_1", RegisterTargetOptions(properties={"plan": "free"}))
    runtime.register_target("user_1", RegisterTargetOptions(properties={"plan": "pro"}))

    targets = adapter.get_registered_targets()
    assert len(targets) == 1
    assert targets[0].properties == {"plan": "pro"}


def test_the_client_surface_reaches_it_too():
    adapter, _lines = harness()
    runtime = FireweaveRuntime(adapter)
    runtime.initialize()
    fw = FireweaveClient(runtime)

    result = fw.register_target("user_3", RegisterTargetOptions(properties={"region": "eu"}))
    assert result.ok is True
    assert len(adapter.get_registered_targets()) == 1


def test_unknown_key_local_mode_returns_default_not_error():
    """spec/modes.md "Behaviour per mode": local's unknown-key row is
    default/DEFAULT — deliberately not an error, unlike remote's
    default/ERROR/FlagNotFound."""
    from fireweave import ErrorKind, EvaluationContext, FlagType

    adapter, _lines = harness()
    runtime = FireweaveRuntime(adapter)
    runtime.initialize()

    decision = runtime.evaluate("unconfigured-flag", FlagType.BOOLEAN, False, EvaluationContext("u"))
    assert decision.value is False
    assert decision.reason == "DEFAULT"
    assert decision.error_kind is None
    assert decision.error_kind != ErrorKind.FLAG_NOT_FOUND


def test_init_fireweave_local_mode_wires_the_recording_seam_end_to_end():
    """The same recorded-and-traced behaviour reached through the sanctioned
    entry point (application/mode.py), not just direct adapter construction."""
    lines = []
    client = init_fireweave(
        mode="local",
        local={"control_points": {"on-flag": True}, "log": lines.append},
    )
    result = client.register_target("user_5")
    assert result.ok is True
    assert len(lines) == 1
    assert "[fireweave:local]" in lines[0]
    client.shutdown()
