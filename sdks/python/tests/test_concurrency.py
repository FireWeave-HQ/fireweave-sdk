"""Concurrency basics: threaded evaluation, shutdown-during-eval, asyncio wrappers."""

from __future__ import annotations

import asyncio
import threading
import time

from fireweave import (
    EvaluationContext,
    FireweaveClient,
    FireweaveRuntime,
    FlagType,
    InMemoryAdapter,
)
from fireweave.aio import AsyncFireweaveClient
from fireweave.errors import ErrorKind

FLAGS = {
    "f": {"type": "boolean", "enabled": True, "variant": "on", "value": True}
}


def make_client(adapter=None) -> FireweaveClient:
    runtime = FireweaveRuntime(adapter or InMemoryAdapter(FLAGS))
    runtime.initialize()
    return FireweaveClient(runtime)


def test_threaded_evaluation_is_consistent():
    client = make_client()
    errors: list = []
    results: list = []

    def worker():
        try:
            for _ in range(200):
                results.append(client.flags.get_boolean_value(
                    "f", False, EvaluationContext("u")
                ))
        except Exception as exc:  # pragma: no cover
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors
    assert len(results) == 1600 and all(results)
    client.shutdown()


def test_shutdown_during_evaluation_never_raises():
    """Concurrent evaluators either get the real value or the AlreadyClosed default."""

    class SlowAdapter(InMemoryAdapter):
        def resolve(self, flag_key, context):
            time.sleep(0.001)
            return super().resolve(flag_key, context)

    client = make_client(SlowAdapter(FLAGS))
    stop = threading.Event()
    outcomes: list = []
    errors: list = []

    def evaluator():
        while not stop.is_set():
            try:
                d = client.flags.get_details(
                    "f", FlagType.BOOLEAN, False, EvaluationContext("u")
                )
                outcomes.append((d.value, d.error_kind))
            except Exception as exc:  # pragma: no cover
                errors.append(exc)

    threads = [threading.Thread(target=evaluator) for _ in range(6)]
    for t in threads:
        t.start()
    time.sleep(0.03)
    client.shutdown()
    time.sleep(0.02)
    stop.set()
    for t in threads:
        t.join()

    assert not errors
    kinds = {k for _, k in outcomes}
    assert kinds <= {None, ErrorKind.ALREADY_CLOSED}
    # Both phases were actually observed.
    assert (True, None) in outcomes
    assert any(k is ErrorKind.ALREADY_CLOSED for _, k in outcomes)


def test_concurrent_shutdown_is_idempotent():
    client = make_client()
    threads = [threading.Thread(target=client.shutdown) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert client.runtime.state.wire_name == "CLOSED"


def test_exposure_dedup_under_concurrency():
    client = make_client()

    def record():
        for _ in range(100):
            client.exposures.record("u1", "f", "on", True)

    threads = [threading.Thread(target=record) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert client.exposures.flush().flushed == 1  # deduped down to one event
    client.shutdown()


def test_async_client_wrappers():
    async def go():
        client = AsyncFireweaveClient(make_client())
        value = await client.get_boolean_value("f", False, EvaluationContext("u"))
        details = await client.get_details(
            "f", FlagType.BOOLEAN, False, EvaluationContext("u")
        )
        release = await client.releases_set_context("rollout_01H")
        signal = await client.signals_record_health("provider", "ok")
        caps = await client.capabilities_get()
        await client.shutdown()
        after = await client.get_details("f", FlagType.BOOLEAN, False)
        return value, details, release, signal, caps, after

    value, details, release, signal, caps, after = asyncio.run(go())
    assert value is True
    assert details.reason == "TARGETING_MATCH"
    assert release.ok and signal.accepted
    assert "capabilities.get" in caps
    assert after.error_kind is ErrorKind.ALREADY_CLOSED


def test_async_parallel_evaluations():
    async def go():
        client = AsyncFireweaveClient(make_client())
        results = await asyncio.gather(
            *[client.get_boolean_value("f", False, EvaluationContext(f"u{i}"))
              for i in range(50)]
        )
        await client.shutdown()
        return results

    assert all(asyncio.run(go()))
