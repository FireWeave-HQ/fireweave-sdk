"""FireweaveProvider through the real OpenFeature 0.10 client (no network)."""

from __future__ import annotations

import pytest
from openfeature import api
from openfeature.evaluation_context import EvaluationContext as OFContext
from openfeature.exception import ErrorCode
from openfeature.flag_evaluation import Reason

from fireweave import FireweaveRuntime, InMemoryAdapter
from fireweave.openfeature import FireweaveProvider

FLAGS = {
    "bool-on": {
        "type": "boolean", "enabled": True, "variant": "on", "value": True,
        "metadata": {"version": 1},
    },
    "theme": {
        "type": "string", "enabled": True, "variant": "dark", "value": "dark",
        "metadata": {"version": 2},
    },
    "limit": {
        "type": "integer", "enabled": True, "variant": "fifty", "value": 50,
    },
    "ratio": {
        "type": "float", "enabled": True, "variant": "half", "value": 0.5,
    },
    "config": {
        "type": "object", "enabled": True, "variant": "v1",
        "value": {"mode": "safe", "threshold": 3},
    },
    "disabled": {
        "type": "boolean", "enabled": False, "variant": "off", "value": False,
    },
}


@pytest.fixture()
def provider() -> FireweaveProvider:
    runtime = FireweaveRuntime(InMemoryAdapter(FLAGS))
    return FireweaveProvider(runtime)


@pytest.fixture()
def of_client(provider):
    api.set_provider(provider)
    yield api.get_client()
    api.shutdown()


CTX = OFContext(targeting_key="user_1")


class TestResolvers:
    def test_boolean(self, of_client):
        details = of_client.get_boolean_details("bool-on", False, CTX)
        assert details.value is True
        assert details.variant == "on"
        assert details.reason == Reason.TARGETING_MATCH
        assert details.flag_metadata["fireweave.flagVersion"] == 1

    def test_string(self, of_client):
        assert of_client.get_string_value("theme", "light", CTX) == "dark"

    def test_integer(self, of_client):
        assert of_client.get_integer_value("limit", 0, CTX) == 50

    def test_float(self, of_client):
        assert of_client.get_float_value("ratio", 0.0, CTX) == 0.5

    def test_object(self, of_client):
        assert of_client.get_object_value("config", {}, CTX) == {
            "mode": "safe", "threshold": 3,
        }

    def test_missing_flag_returns_default_with_error_details(self, of_client):
        details = of_client.get_boolean_details("nope", False, CTX)
        assert details.value is False
        assert details.reason == Reason.ERROR
        assert details.error_code == ErrorCode.FLAG_NOT_FOUND
        assert details.flag_metadata["fireweave.errorKind"] == "FlagNotFound"

    def test_type_mismatch_returns_default(self, of_client):
        details = of_client.get_string_details("bool-on", "fallback", CTX)
        assert details.value == "fallback"
        assert details.error_code == ErrorCode.TYPE_MISMATCH

    def test_int_flag_readable_as_float_but_not_reverse(self, of_client):
        assert of_client.get_float_value("limit", 0.0, CTX) == 50.0
        details = of_client.get_integer_details("ratio", 0, CTX)
        assert details.error_code == ErrorCode.TYPE_MISMATCH

    def test_disabled_flag_reason(self, of_client):
        details = of_client.get_boolean_details("disabled", True, CTX)
        assert details.value is False
        assert details.reason == Reason.DISABLED

    def test_missing_context_is_fine_without_require_targeting_key(self, of_client):
        assert of_client.get_boolean_value("bool-on", False) is True


class TestLifecycleIntegration:
    def test_metadata_name(self, provider):
        assert provider.get_metadata().name.startswith("fireweave/")

    def test_evaluation_after_provider_shutdown(self, provider):
        api.set_provider(provider)
        client = api.get_client()
        assert client.get_boolean_value("bool-on", False, CTX) is True
        provider.shutdown()
        details = client.get_boolean_details("bool-on", False, CTX)
        assert details.value is False
        # AlreadyClosed maps to PROVIDER_NOT_READY per contracts/errors.json.
        assert details.error_code == ErrorCode.PROVIDER_NOT_READY
        assert details.flag_metadata["fireweave.errorKind"] == "AlreadyClosed"
        api.shutdown()

    def test_provider_replacement(self):
        api.set_provider(FireweaveProvider(FireweaveRuntime(InMemoryAdapter(
            {"old": {"type": "boolean", "enabled": True, "variant": "on", "value": True}}
        ))))
        api.set_provider(FireweaveProvider(FireweaveRuntime(InMemoryAdapter(
            {"new": {"type": "boolean", "enabled": True, "variant": "on", "value": True}}
        ))))
        client = api.get_client()
        assert client.get_boolean_value("new", False, CTX) is True
        api.shutdown()

    def test_api_level_context_becomes_global_layer(self):
        adapter = InMemoryAdapter({
            "merge": {
                "type": "string", "enabled": True, "variant": "gold",
                "value": "gold", "matchAttribute": {"tier": "gold"},
            }
        })
        provider = FireweaveProvider(FireweaveRuntime(adapter))
        api.set_evaluation_context(OFContext("org_1", {"tier": "bronze"}))
        api.set_provider(provider)
        client = api.get_client()
        # Invocation layer wins over the global layer.
        value = client.get_string_value(
            "merge", "none", OFContext(attributes={"tier": "gold"})
        )
        assert value == "gold"
        api.shutdown()
        api.set_evaluation_context(OFContext())


class TestAsyncResolvers:
    def test_async_resolution_delegates_to_sync_core(self, provider):
        import asyncio

        api.set_provider(provider)
        client = api.get_client()

        async def go():
            details = await client.get_boolean_details_async("bool-on", False, CTX)
            return details

        details = asyncio.run(go())
        assert details.value is True
        assert details.reason == Reason.TARGETING_MATCH
        api.shutdown()
