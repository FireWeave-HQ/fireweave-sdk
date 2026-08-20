"""init_fireweave — the single SDK entry point (spec/modes.md).

`mode` is required and never inferred. Initialisation-validation table
(spec/modes.md "Initialisation validation"): all four rows RAISE
`ConfigurationError`; reads on the returned client never raise.
"""

from __future__ import annotations

import pytest

from fireweave import ConfigurationError, EvaluationContext, FireweaveClient, init_fireweave


class TestInitialisationValidationTable:
    def test_mode_absent_raises_configuration(self):
        with pytest.raises(ConfigurationError):
            init_fireweave(api_key="k", api_url="https://app-server.fireweave.ai")

    def test_mode_unrecognised_raises_configuration(self):
        with pytest.raises(ConfigurationError):
            init_fireweave(mode="prod")

    def test_remote_missing_api_key_raises_configuration(self):
        with pytest.raises(ConfigurationError):
            init_fireweave(mode="remote", api_url="https://app-server.fireweave.ai")

    def test_remote_missing_api_url_raises_configuration(self):
        with pytest.raises(ConfigurationError):
            init_fireweave(mode="remote", api_key="k")

    def test_remote_blank_api_key_raises_configuration(self):
        with pytest.raises(ConfigurationError):
            init_fireweave(mode="remote", api_key="   ", api_url="https://app-server.fireweave.ai")

    def test_apiurl_fails_host_allowlist_raises_configuration(self):
        with pytest.raises(ConfigurationError):
            init_fireweave(mode="remote", api_key="k", api_url="https://evil.example.com")

    def test_local_combined_with_api_key_raises_configuration(self):
        with pytest.raises(ConfigurationError):
            init_fireweave(mode="local", api_key="k")

    def test_local_combined_with_api_url_raises_configuration(self):
        with pytest.raises(ConfigurationError):
            init_fireweave(mode="local", api_url="https://app-server.fireweave.ai")


class TestSuccessfulPaths:
    def test_local_mode_builds_a_ready_client(self):
        client = init_fireweave(mode="local", local={"control_points": {"f": True}})
        assert isinstance(client, FireweaveClient)
        assert client.control_points.get_boolean_value("f", False) is True
        client.shutdown()

    def test_local_mode_may_omit_local_entirely(self):
        client = init_fireweave(mode="local")
        assert client.control_points.get_boolean_value("f", False) is False
        client.shutdown()

    def test_remote_mode_builds_a_ready_client_against_injected_transport(self):
        def transport(url, body, headers, timeout):
            assert headers["Authorization"] == "Bearer project-api-key_x"
            return 200, {
                "decisions": [
                    {"flagKey": "f", "found": True, "value": True, "enabled": True, "reason": "TARGETING_MATCH"}
                ]
            }

        client = init_fireweave(
            mode="remote",
            api_key="project-api-key_x",
            api_url="https://app-server.fireweave.ai",
            transport=transport,
        )
        value = client.control_points.get_boolean_value("f", False, EvaluationContext("u1"))
        assert value is True
        client.shutdown()

    def test_remote_mode_accepts_a_self_hosted_url_via_explicit_allowed_hosts(self):
        def transport(url, body, headers, timeout):
            return 200, {"decisions": []}

        client = init_fireweave(
            mode="remote",
            api_key="k",
            api_url="https://fw.selfhosted.example.com",
            allowed_hosts=("fw.selfhosted.example.com",),
            transport=transport,
        )
        client.shutdown()


class TestReadsNeverRaise:
    """spec/control-points.md "Return discipline": initialisation is the
    named exception (raises loudly); reads on the returned client never do
    — including a cyclic invocation context."""

    def test_read_after_successful_local_init_never_raises_for_malformed_input(self):
        client = init_fireweave(mode="local", local={"control_points": {"f": True}})
        cyclic: dict = {}
        cyclic["self"] = cyclic
        decision = client.control_points.get_boolean_details(
            "", False, EvaluationContext("u", {"loop": cyclic})
        )
        assert decision.value is False
        assert decision.reason == "ERROR"
        client.shutdown()

    def test_read_after_shutdown_degrades_already_closed(self):
        client = init_fireweave(mode="local")
        client.shutdown()
        decision = client.control_points.get_boolean_details("f", False)
        assert decision.value is False
        assert decision.reason == "ERROR"
        assert decision.error_kind is not None
