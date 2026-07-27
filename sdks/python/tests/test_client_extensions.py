"""FireweaveClient extensions: releases, exposures, signals, guardrails, capabilities."""

from __future__ import annotations

from fireweave import CapabilityRegistry, FireweaveClient, FireweaveRuntime, InMemoryAdapter
from fireweave.errors import ErrorKind


class TestReleases:
    def test_set_context_binds_identity(self, client):
        result = client.releases.set_context(
            "rollout_01H", "chg_01H", ["stmp_01H", "stmp_02H"]
        )
        assert result.ok
        assert result.release_context.rollout_id == "rollout_01H"
        assert result.release_context.stamp_ids == ("stmp_01H", "stmp_02H")

    def test_start_complete_fail_lifecycle(self, client):
        client.releases.set_context("rollout_01H")
        assert client.releases.start().status == "in_progress"
        assert client.releases.complete().status == "completed"
        failed = client.releases.fail(reason="guardrail_breach")
        assert failed.status == "failed" and failed.reason == "guardrail_breach"

    def test_fail_reason_redacted(self, client):
        client.releases.set_context("rollout_01H")
        result = client.releases.fail(reason="deploy with key phc_SECRET123 failed")
        assert "phc_" not in result.reason

    def test_ops_without_context_degrade(self, client):
        result = client.releases.start()
        assert not result.ok
        assert result.error_kind is ErrorKind.CONFIGURATION


class TestExposures:
    def test_record_queues(self, client):
        result = client.exposures.record("u1", "f", "on", True)
        assert result.ok and result.queued == 1 and not result.deduped

    def test_duplicate_deduped(self, client):
        client.exposures.record("u1", "f", "on", True)
        result = client.exposures.record("u1", "f", "on", True)
        assert result.deduped and result.queued == 1

    def test_different_value_not_deduped(self, client):
        client.exposures.record("u1", "f", "on", True)
        result = client.exposures.record("u1", "f", "off", False)
        assert not result.deduped and result.queued == 2

    def test_flush_drains(self, client):
        client.exposures.record("u1", "f", "on", True)
        client.exposures.record("u2", "f", "on", True)
        result = client.exposures.flush()
        assert result.flushed == 2 and result.queued == 0
        assert client.exposures.flush().flushed == 0

    def test_flush_forwards_to_adapter_sink(self):
        sent = []

        class SinkAdapter(InMemoryAdapter):
            def send_exposures(self, events):
                sent.extend(events)

        runtime = FireweaveRuntime(SinkAdapter({}))
        runtime.initialize()
        client = FireweaveClient(runtime)
        client.exposures.record("u1", "f", "on", True)
        client.exposures.flush()
        assert sent[0]["flagKey"] == "f"


class TestSignals:
    def test_record_health(self, client):
        result = client.signals.record_health("provider", "ok", "rollout_01H")
        assert result.ok and result.accepted
        assert result.recorded == {
            "kind": "health", "name": "provider", "status": "ok",
            "rolloutId": "rollout_01H",
        }

    def test_record_error_redacts_message(self, client):
        result = client.signals.record_error(
            "evaluation", "Timeout", "timed out calling phs_SECRET endpoint"
        )
        assert result.accepted
        assert "phs_" not in result.recorded["message"]

    def test_record_metric(self, client):
        result = client.signals.record_metric(
            "rollout.adoption", 1, rollout_id="rollout_01H", stamp_id="stmp_01H"
        )
        assert result.recorded["value"] == 1
        assert result.recorded["stampId"] == "stmp_01H"

    def test_record_outcome(self, client):
        result = client.signals.record_outcome(
            "release", "completed", "rollout_01H", "chg_01H"
        )
        assert result.recorded["changeId"] == "chg_01H"

    def test_allowlist_drops_unknown_attributes(self, client):
        # email is not on the telemetry allowlist -> silently dropped.
        result = client.signals._record("health", "provider", status="ok",
                                        email="alice@example.com")
        assert "email" not in result.recorded


class TestGuardrailsAndCapabilities:
    def test_guardrails_stub_degrades(self, client):
        result = client.guardrails.check("latency")
        assert not result.ok and result.degraded
        assert result.error_kind is ErrorKind.UNSUPPORTED_CAPABILITY
        assert result.error_code == "GENERAL"

    def test_capabilities_get_canonical_order(self, client):
        caps = client.capabilities.get()
        assert caps[0] == "releases.setContext"
        assert "capabilities.get" in caps
        assert len(caps) == 11

    def test_unknown_capability_degrades_no_throw(self, client):
        result = client.capabilities.invoke("releases.teleport")
        assert not result.ok and result.degraded
        assert result.error_message == "unsupported capability"

    def test_negotiated_subset_stays_disabled(self):
        runtime = FireweaveRuntime(InMemoryAdapter({}))
        runtime.initialize()
        registry = CapabilityRegistry(["exposures.record", "exposures.flush"])
        client = FireweaveClient(runtime, capabilities=registry)
        assert client.capabilities.get() == ["exposures.record", "exposures.flush"]
        result = client.capabilities.invoke("releases.start")
        assert not result.ok and result.degraded

    def test_enabled_capability_invokable_dynamically(self, client):
        result = client.capabilities.invoke(
            "exposures.record", targeting_key="u", flag_key="f", variant="on", value=True
        )
        assert result.ok and result.value.queued == 1


class TestShutdownFacade:
    def test_shutdown_flushes_exposures(self, simple_flags):
        sent = []

        class SinkAdapter(InMemoryAdapter):
            def send_exposures(self, events):
                sent.extend(events)

        runtime = FireweaveRuntime(SinkAdapter(simple_flags))
        runtime.initialize()
        client = FireweaveClient(runtime)
        client.exposures.record("u1", "bool-on", "on", True)
        client.shutdown()
        assert len(sent) == 1

    def test_context_manager(self, simple_flags):
        runtime = FireweaveRuntime(InMemoryAdapter(simple_flags))
        runtime.initialize()
        with FireweaveClient(runtime) as client:
            assert client.flags.get_boolean_value("bool-on", False) is True
        assert runtime.state.wire_name == "CLOSED"
