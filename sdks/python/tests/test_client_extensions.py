"""FireweaveClient extensions: releases, exposures, signals, guardrails, capabilities."""

from __future__ import annotations

from fireweave import CapabilityRegistry, FireweaveClient, FireweaveRuntime, InMemoryAdapter
from fireweave.errors import ErrorKind


# Valid typed ULIDs per spec/release-context.schema.json patterns.
CHG = "chg_01HZXRE0000000000000000001"
STAMP_A = "stmp_01HZXRE0000000000000000001"
STAMP_B = "stmp_01HZXRE0000000000000000002"


class TestReleases:
    def test_set_context_binds_identity(self, client):
        result = client.releases.set_context("rollout_01H", CHG, [STAMP_A, STAMP_B])
        assert result.ok
        assert result.release_context.rollout_id == "rollout_01H"
        assert result.release_context.stamp_ids == (STAMP_A, STAMP_B)

    def test_start_complete_fail_lifecycle(self, client):
        client.releases.set_context("rollout_01H", stamp_ids=[STAMP_A])
        assert client.releases.start().status == "in_progress"
        assert client.releases.complete().status == "completed"
        failed = client.releases.fail(reason="guardrail_breach")
        assert failed.status == "failed" and failed.reason == "guardrail_breach"

    def test_fail_reason_redacted(self, client):
        client.releases.set_context("rollout_01H", stamp_ids=[STAMP_A])
        result = client.releases.fail(reason="deploy with key phc_SECRET123 failed")
        assert "phc_" not in result.reason

    def test_ops_without_context_degrade(self, client):
        result = client.releases.start()
        assert not result.ok
        assert result.error_kind is ErrorKind.CONFIGURATION


class TestReleaseContextValidation:
    """Ruling 15: exactly spec/release-context.schema.json required fields."""

    def test_missing_rollout_id_rejected(self, client):
        result = client.releases.set_context("", stamp_ids=[STAMP_A])
        assert not result.ok and result.error_kind is ErrorKind.CONFIGURATION
        assert result.error_code == "GENERAL"

    def test_missing_stamp_ids_rejected(self, client):
        result = client.releases.set_context("rollout_01H")
        assert not result.ok and result.error_kind is ErrorKind.CONFIGURATION

    def test_malformed_stamp_id_rejected(self, client):
        result = client.releases.set_context("rollout_01H", stamp_ids=["stmp_short"])
        assert not result.ok and result.error_kind is ErrorKind.CONFIGURATION

    def test_duplicate_stamp_ids_rejected(self, client):
        result = client.releases.set_context("rollout_01H", stamp_ids=[STAMP_A, STAMP_A])
        assert not result.ok

    def test_malformed_change_id_rejected(self, client):
        result = client.releases.set_context("rollout_01H", "chg_short", [STAMP_A])
        assert not result.ok and result.error_kind is ErrorKind.CONFIGURATION

    def test_change_id_optional(self, client):
        assert client.releases.set_context("rollout_01H", None, [STAMP_A]).ok

    def test_oversized_rollout_id_rejected(self, client):
        result = client.releases.set_context("r" * 129, stamp_ids=[STAMP_A])
        assert not result.ok

    def test_invalid_context_not_bound(self, client):
        client.releases.set_context("rollout_01H", stamp_ids=["stmp_bogus"])
        assert client.releases.context is None


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

    def test_capabilities_names_canonical_order(self, client):
        caps = client.capabilities.names()
        assert caps[0] == "releases.setContext"
        assert "capabilities.get" in caps
        assert len(caps) == 11

    def test_capabilities_get_returns_structured_matrix(self, client):
        """Ruling 18: spec/capabilities.schema.json shape, not a name list."""
        matrix = client.capabilities.get()
        assert set(matrix) == {"static", "runtime"}
        static, runtime = matrix["static"], matrix["runtime"]
        assert static["language"] == "python"
        assert static["specVersion"] == "0.1.0"
        assert static["openFeature"] == {
            "specFloor": "0.8.0", "providerName": "fireweave", "serverOnly": True,
        }
        assert static["features"]["flags"] is True
        assert static["features"]["inMemoryAdapter"] is True
        assert static["features"]["releases"] is True
        assert static["features"]["guardrails"] is False
        assert runtime["backend"] == "inmemory"
        assert runtime["lifecycle"] == "READY"
        assert runtime["limits"] == {
            "intSafeMaxAbs": 9007199254740991,
            "shutdownTimeoutMsDefault": 10000,
        }
        assert all(isinstance(v, bool) for v in runtime["features"].values())

    def test_capabilities_matrix_tracks_lifecycle(self, simple_flags):
        runtime = FireweaveRuntime(InMemoryAdapter(simple_flags))
        client = FireweaveClient(runtime)
        assert client.capabilities.get()["runtime"]["lifecycle"] == "UNINITIALIZED"
        runtime.initialize()
        assert client.capabilities.get()["runtime"]["lifecycle"] == "READY"
        client.shutdown()
        assert client.capabilities.get()["runtime"]["lifecycle"] == "SHUTDOWN"

    def test_unknown_capability_degrades_no_throw(self, client):
        result = client.capabilities.invoke("releases.teleport")
        assert not result.ok and result.degraded
        assert result.error_message == "unsupported capability"

    def test_negotiated_subset_stays_disabled(self):
        runtime = FireweaveRuntime(InMemoryAdapter({}))
        runtime.initialize()
        registry = CapabilityRegistry(["exposures.record", "exposures.flush"])
        client = FireweaveClient(runtime, capabilities=registry)
        assert client.capabilities.names() == ["exposures.record", "exposures.flush"]
        matrix = client.capabilities.get()
        assert matrix["static"]["features"]["exposures"] is True
        assert matrix["static"]["features"]["releases"] is False
        result = client.capabilities.invoke("releases.start")
        assert not result.ok and result.degraded

    def test_enabled_capability_invokable_dynamically(self, client):
        result = client.capabilities.invoke(
            "exposures.record", targeting_key="u", flag_key="f", variant="on", value=True
        )
        assert result.ok and result.value.queued == 1


class TestLifecycleGating:
    """Ruling 17: extension calls are lifecycle-gated, degrade, never raise."""

    @staticmethod
    def _uninitialized_client(flags=None) -> FireweaveClient:
        return FireweaveClient(FireweaveRuntime(InMemoryAdapter(flags or {})))

    @staticmethod
    def _closed_client(flags=None) -> FireweaveClient:
        runtime = FireweaveRuntime(InMemoryAdapter(flags or {}))
        runtime.initialize()
        client = FireweaveClient(runtime)
        client.shutdown()
        return client

    def test_pre_ready_calls_degrade_unsupported_capability(self):
        client = self._uninitialized_client()
        for result in (
            client.releases.set_context("rollout_01H", stamp_ids=[STAMP_A]),
            client.releases.start("rollout_01H"),
            client.exposures.record("u", "f", "on", True),
            client.exposures.flush(),
            client.signals.record_health("provider", "ok"),
        ):
            assert not result.ok
            assert result.degraded
            assert result.error_kind is ErrorKind.UNSUPPORTED_CAPABILITY
            assert result.error_code == "GENERAL"
            assert result.error_message == "unsupported capability"

    def test_post_shutdown_calls_degrade_already_closed(self):
        client = self._closed_client()
        for result in (
            client.releases.set_context("rollout_01H", stamp_ids=[STAMP_A]),
            client.releases.complete("rollout_01H"),
            client.exposures.record("u", "f", "on", True),
            client.exposures.flush(),
            client.signals.record_metric("m", 1.0),
        ):
            assert not result.ok
            assert result.degraded
            assert result.error_kind is ErrorKind.ALREADY_CLOSED
            assert result.error_code == "PROVIDER_NOT_READY"
            assert result.error_message == "provider already closed"

    def test_pre_ready_exposure_not_queued(self):
        client = self._uninitialized_client()
        client.exposures.record("u", "f", "on", True)
        assert client.exposures.queued == 0

    def test_stale_state_passes_gate(self, simple_flags):
        runtime = FireweaveRuntime(InMemoryAdapter(simple_flags))
        runtime.initialize()
        runtime.mark_stale()
        client = FireweaveClient(runtime)
        assert client.signals.record_health("provider", "degraded").ok


class TestAdapterSinkDelivery:
    """Ruling 17: READY-state extension calls deliver to the adapter sink."""

    class SinkAdapter(InMemoryAdapter):
        def __init__(self, flags=None):
            super().__init__(flags or {})
            self.signals = []
            self.releases = []
            self.exposures = []

        def deliver_signal(self, signal):
            self.signals.append(signal)

        def deliver_release(self, event):
            self.releases.append(event)

        def send_exposures(self, events):
            self.exposures.extend(events)

    def _client(self):
        adapter = self.SinkAdapter()
        runtime = FireweaveRuntime(adapter)
        runtime.initialize()
        return FireweaveClient(runtime), adapter

    def test_signals_delivered_to_sink(self):
        client, adapter = self._client()
        client.signals.record_health("provider", "ok", rollout_id="rollout_01H")
        assert adapter.signals == [
            {"kind": "health", "name": "provider", "status": "ok",
             "rolloutId": "rollout_01H"}
        ]

    def test_release_transitions_delivered_to_sink(self):
        client, adapter = self._client()
        client.releases.set_context("rollout_01H", stamp_ids=[STAMP_A])
        client.releases.start()
        client.releases.fail(reason="guardrail_breach")
        statuses = [e["status"] for e in adapter.releases]
        assert statuses == ["context_set", "in_progress", "failed"]
        assert adapter.releases[-1]["reason"] == "guardrail_breach"

    def test_sink_exception_never_reaches_caller(self):
        class ExplodingSink(InMemoryAdapter):
            def deliver_signal(self, signal):
                raise RuntimeError("sink boom")

            def deliver_release(self, event):
                raise RuntimeError("sink boom")

        runtime = FireweaveRuntime(ExplodingSink({}))
        runtime.initialize()
        client = FireweaveClient(runtime)
        assert client.signals.record_health("provider", "ok").ok
        assert client.releases.set_context("rollout_01H", stamp_ids=[STAMP_A]).ok


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

    def test_flags_evaluate_decision_api(self, simple_flags):
        """Ruling 16 / architecture flags.evaluate — Decision without OF."""
        from fireweave import EvaluationContext, FlagType

        runtime = FireweaveRuntime(InMemoryAdapter(simple_flags))
        runtime.initialize()
        client = FireweaveClient(runtime)
        d = client.flags.evaluate(
            "bool-on",
            FlagType.BOOLEAN,
            False,
            EvaluationContext("user_42"),
            send_exposure=False,
        )
        assert d.value is True
        assert d.error_kind is None
        # Alias parity with get_details.
        d2 = client.flags.get_details(
            "bool-on", FlagType.BOOLEAN, False, EvaluationContext("user_42")
        )
        assert d2.value == d.value
