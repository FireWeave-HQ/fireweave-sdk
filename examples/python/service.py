"""Fireweave Python SDK — plain service example.

Offline by default: runs against the in-memory adapter with the demo flags
below. Set ``FIREWEAVE_POSTHOG_KEY`` (a ``phc_`` project API key) to switch to
the PostHog-backed adapter instead — no code changes required.

    python service.py                          # offline, in-memory
    FIREWEAVE_POSTHOG_KEY=phc_... python service.py   # PostHog-backed

Demonstrates:
  * PostHog-backed (or in-memory) OpenFeature provider registration
  * boolean evaluation and detailed resolution
  * targeting context (targetingKey -> distinct_id)
  * releases.set_context + signals.record_health
  * clean, deterministic shutdown
"""

from __future__ import annotations

import os

from openfeature import api
from openfeature.evaluation_context import EvaluationContext as OFContext

from fireweave import (
    BackendAdapter,
    EvaluationContext,
    FireweaveClient,
    FireweaveConfig,
    FireweaveRuntime,
    FlagType,
    InMemoryAdapter,
)
from fireweave.openfeature import FireweaveProvider

DEMO_FLAGS = {
    "new-checkout": {
        "type": "boolean",
        "enabled": True,
        "variant": "on",
        "value": True,
        "metadata": {"version": 3},
    },
    "checkout-theme": {
        "type": "string",
        "enabled": True,
        "variant": "dark",
        "value": "dark",
        "matchAttribute": {"tier": "gold"},
    },
}


def build_adapter() -> BackendAdapter:
    """In-memory by default; PostHog-backed when FIREWEAVE_POSTHOG_KEY is set."""
    api_key = os.environ.get("FIREWEAVE_POSTHOG_KEY")
    if not api_key:
        return InMemoryAdapter(DEMO_FLAGS)
    # Requires: pip install 'fireweave[posthog]'
    from fireweave.adapters.posthog import PostHogAdapter

    config = FireweaveConfig(
        project_api_key=api_key,
        host=os.environ.get("FIREWEAVE_POSTHOG_HOST", "https://us.i.posthog.com"),
    )
    return PostHogAdapter(config=config)


def main() -> None:
    # 1. Construct everything explicitly — no hidden globals.
    runtime = FireweaveRuntime(build_adapter())
    provider = FireweaveProvider(runtime)

    # 2. Register the provider with OpenFeature (this initializes the runtime).
    api.set_provider(provider)
    of_client = api.get_client()

    # 3. Boolean evaluation with a targeting context.
    ctx = OFContext(targeting_key="user_42", attributes={"tier": "gold"})
    if of_client.get_boolean_value("new-checkout", False, ctx):
        print("new-checkout: ENABLED for user_42")

    # 4. Detailed resolution: variant, reason, and Fireweave flag metadata.
    details = of_client.get_string_details("checkout-theme", "light", ctx)
    print(
        f"checkout-theme: value={details.value!r} variant={details.variant!r} "
        f"reason={details.reason} metadata={dict(details.flag_metadata)}"
    )

    # 5. Release-safety extensions on the Fireweave client (same runtime).
    fw = FireweaveClient(runtime)
    fw.releases.set_context(
        rollout_id="rollout_01HZX3", change_id="chg_01HZX3", stamp_ids=["stmp_01HZX3"]
    )
    fw.releases.start()
    fw.signals.record_health("checkout-service", "ok", rollout_id="rollout_01HZX3")
    fw.exposures.record("user_42", "new-checkout", "on", True)

    # Fireweave evaluation API works alongside OpenFeature, same semantics.
    decision = fw.flags.get_details(
        "new-checkout", FlagType.BOOLEAN, False,
        EvaluationContext("user_42", {"tier": "gold"}),
    )
    print(f"fireweave decision: value={decision.value} reason={decision.reason}")

    # 6. Clean shutdown: flushes exposures, closes the adapter, and makes
    #    later evaluations degrade to defaults (AlreadyClosed) — never raise.
    fw.releases.complete()
    fw.shutdown()
    api.shutdown()
    print("shut down cleanly")


if __name__ == "__main__":
    main()
