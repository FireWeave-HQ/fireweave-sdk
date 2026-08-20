"""Concurrency basics: threaded evaluation, shutdown-during-eval."""

from __future__ import annotations

import threading
import time

from fireweave import (
    ErrorKind,
    EvaluationContext,
    FireweaveClient,
    FireweaveRuntime,
    InMemoryAdapter,
)

FLAGS = {
    "f": {"enabled": True, "variant": "on", "value": True}
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
                results.append(client.control_points.get_boolean_value(
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
                d = client.control_points.get_boolean_details("f", False, EvaluationContext("u"))
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
