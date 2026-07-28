"""Fireweave Python SDK — FastAPI example.

Offline by default (in-memory adapter); set ``FIREWEAVE_POSTHOG_KEY`` to use
the PostHog-backed adapter. Requires: pip install fastapi uvicorn

    uvicorn fastapi_app:app --reload
    curl 'http://127.0.0.1:8000/checkout?user_id=user_42&tier=gold'
    curl 'http://127.0.0.1:8000/flags/new-checkout?user_id=user_42'

Patterns shown:
  * one SDK client for the process, created in the FastAPI lifespan and shut
    down deterministically on exit (flushes exposures, closes the adapter)
  * per-request targeting context built from request data
  * boolean gating + detailed resolution endpoints
  * releases.set_context + signals.record_health at startup
  * asyncio-safe: the sync core is thread-safe and evaluations are fast and
    non-blocking for in-memory/local-eval; use fireweave.aio for remote calls
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import AsyncIterator, Optional

from fastapi import FastAPI, Request

from fireweave import (
    BackendAdapter,
    EvaluationContext,
    FireweaveClient,
    FireweaveConfig,
    FireweaveRuntime,
    FlagType,
    InMemoryAdapter,
)

DEMO_FLAGS = {
    "new-checkout": {
        "type": "boolean", "enabled": True, "variant": "on", "value": True,
        "metadata": {"version": 3},
    },
    "checkout-theme": {
        "type": "string", "enabled": True, "variant": "dark", "value": "dark",
        "matchAttribute": {"tier": "gold"},
    },
}


def build_adapter() -> BackendAdapter:
    api_key = os.environ.get("FIREWEAVE_POSTHOG_KEY")
    if not api_key:
        return InMemoryAdapter(DEMO_FLAGS)
    from fireweave.adapters.posthog import PostHogAdapter  # fireweave[posthog]

    return PostHogAdapter(config=FireweaveConfig(
        project_api_key=api_key,
        host=os.environ.get("FIREWEAVE_POSTHOG_HOST", "https://us.i.posthog.com"),
    ))


def build_client(adapter: Optional[BackendAdapter] = None) -> FireweaveClient:
    """Factory used by the app and, with an injected adapter, by tests."""
    runtime = FireweaveRuntime(adapter or build_adapter())
    runtime.initialize()
    return FireweaveClient(runtime)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    client = build_client()
    # changeId/stampIds are typed 26-char ULIDs; rolloutId + stampIds are
    # required (spec/release-context.schema.json, ruling 15).
    client.releases.set_context(
        rollout_id="rollout_01HZX3",
        change_id="chg_01HZXEX0000000000000000001",
        stamp_ids=["stmp_01HZXEX0000000000000000001"],
    )
    client.signals.record_health("checkout-service", "ok",
                                 rollout_id="rollout_01HZX3")
    app.state.fireweave = client
    try:
        yield
    finally:
        # Deterministic shutdown: flush exposures, close the adapter.
        client.shutdown()


app = FastAPI(lifespan=lifespan)


def request_context(user_id: str, tier: Optional[str] = None) -> EvaluationContext:
    """Per-request targeting context; targetingKey maps to distinct_id."""
    attributes = {"tier": tier} if tier else {}
    return EvaluationContext(targeting_key=user_id, attributes=attributes)


@app.get("/checkout")
def checkout(request: Request, user_id: str, tier: Optional[str] = None):
    fw: FireweaveClient = request.app.state.fireweave
    ctx = request_context(user_id, tier)
    use_new = fw.flags.get_boolean_value("new-checkout", False, ctx)
    theme = fw.flags.get_string_value("checkout-theme", "light", ctx)
    if use_new:
        fw.exposures.record(user_id, "new-checkout", "on", True)
    return {"checkout": "v2" if use_new else "v1", "theme": theme}


@app.get("/flags/{flag_key}")
def flag_details(request: Request, flag_key: str, user_id: str,
                 tier: Optional[str] = None):
    """Detailed resolution: value, variant, reason, error kind, metadata."""
    fw: FireweaveClient = request.app.state.fireweave
    decision = fw.flags.get_details(
        flag_key, FlagType.BOOLEAN, False, request_context(user_id, tier)
    )
    return {
        "flagKey": flag_key,
        "value": decision.value,
        "variant": decision.variant,
        "reason": decision.reason,
        "errorKind": decision.error_kind.value if decision.error_kind else None,
        "flagMetadata": dict(decision.flag_metadata),
    }


@app.get("/health")
def health(request: Request):
    fw: FireweaveClient = request.app.state.fireweave
    fw.signals.record_health("checkout-service", "ok", rollout_id="rollout_01HZX3")
    return {"status": "ok", "sdkState": fw.runtime.state.wire_name}
