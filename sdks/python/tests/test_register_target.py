"""Target registration — POST /v1/targets/register parity with Node."""

from __future__ import annotations

from fireweave import (
    FireweaveRemoteAdapter,
    FireweaveRuntime,
    InMemoryAdapter,
    RegisterTargetOptions,
)
from fireweave.errors import ErrorKind


def _ready_adapter(transport):
    adapter = FireweaveRemoteAdapter(
        api_url="http://127.0.0.1:3901",
        api_key="project-api-key_test",
        transport=transport,
    )
    adapter.initialize()
    return adapter


class TestRemoteRegisterTarget:
    def test_posts_target_with_bearer_auth(self):
        calls = []

        def transport(url, body, headers, timeout):
            calls.append((url, body, headers))
            assert url.endswith("/v1/targets/register")
            return 200, {"ok": True, "targetingKey": "user-1"}

        adapter = _ready_adapter(transport)
        result = adapter.register_target(
            "user-1",
            RegisterTargetOptions(
                kind="user",
                environment="production",
                properties={"plan": "enterprise", "beta": True},
            ),
        )

        assert result.ok is True
        assert len(calls) == 1
        assert calls[0][2]["Authorization"] == "Bearer project-api-key_test"
        body = calls[0][1]
        assert body["targetingKey"] == "user-1"
        assert body["kind"] == "user"
        assert body["environment"] == "production"
        assert body["properties"] == {"plan": "enterprise", "beta": True}

    def test_omits_optional_fields(self):
        calls = []

        def transport(url, body, headers, timeout):
            calls.append(body)
            return 200, {"ok": True}

        adapter = _ready_adapter(transport)
        adapter.register_target("device-9")

        assert list(calls[0].keys()) == ["targetingKey"]

    def test_never_throws_on_transport_failure(self):
        adapter = _ready_adapter(lambda *a: (500, {}))
        result = adapter.register_target("user-1")
        assert result.ok is False
        assert result.error.kind is ErrorKind.BACKEND_UNAVAILABLE

    def test_retries_retryable_failure_once(self):
        calls = []
        attempts = {"n": 0}

        def transport(url, body, headers, timeout):
            attempts["n"] += 1
            calls.append(url)
            if attempts["n"] == 1:
                return 503, {}
            return 200, {"ok": True}

        adapter = _ready_adapter(transport)
        result = adapter.register_target("user-1")
        assert result.ok is True
        assert len(calls) == 2

    def test_does_not_retry_auth_failure(self):
        calls = []

        def transport(url, body, headers, timeout):
            calls.append(url)
            return 401, {}

        adapter = _ready_adapter(transport)
        result = adapter.register_target("user-1")
        assert result.ok is False
        assert result.error.kind is ErrorKind.AUTHENTICATION
        assert len(calls) == 1

    def test_not_ready_before_initialize(self):
        adapter = FireweaveRemoteAdapter(
            api_url="http://127.0.0.1:3901",
            api_key="project-api-key_test",
            transport=lambda *a: (200, {"ok": True}),
        )
        result = adapter.register_target("user-1")
        assert result.ok is False
        assert result.error.kind is ErrorKind.NOT_READY

    def test_rejects_empty_targeting_key(self):
        adapter = _ready_adapter(lambda *a: (200, {"ok": True}))
        result = adapter.register_target("")
        assert result.ok is False
        assert result.error.kind is ErrorKind.INVALID_CONTEXT


class TestRuntimeRegisterTarget:
    def test_delegates_to_adapter(self):
        calls = []

        def transport(url, body, headers, timeout):
            calls.append(url)
            return 200, {"ok": True}

        adapter = FireweaveRemoteAdapter(
            api_url="http://127.0.0.1:3901",
            api_key="project-api-key_test",
            transport=transport,
        )
        runtime = FireweaveRuntime(adapter)
        runtime.initialize()
        result = runtime.register_target(
            "user-1", RegisterTargetOptions(properties={"plan": "pro"})
        )
        assert result.ok is True
        assert calls[0].endswith("/v1/targets/register")

    def test_unsupported_on_inmemory(self):
        runtime = FireweaveRuntime(InMemoryAdapter({}))
        runtime.initialize()
        result = runtime.register_target("user-1")
        assert result.ok is False
        assert result.error.kind is ErrorKind.UNSUPPORTED_CAPABILITY
