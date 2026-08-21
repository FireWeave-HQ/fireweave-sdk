"""Fireweave Python SDK — minimal service example.

Default mode runs fully OFFLINE (mode="local", no network, no credentials).

Production path (ADR-0005):
    FW_API_URL=... FW_PROJECT_API_KEY=... python service.py --remote

Stub: node test-server/implementation/server.mjs  (127.0.0.1:3901)

Demonstrates the two v1 capabilities (spec/control-points.md):
  * init_fireweave — the single entry point, local or remote
  * control_points boolean read + detailed resolution, with a targeting context
  * register_target — durable targeting facts, once per login
  * clean, deterministic shutdown
"""

from __future__ import annotations

import os
import sys

from fireweave import EvaluationContext, RegisterTargetOptions, init_fireweave

USE_REMOTE = "--remote" in sys.argv or os.environ.get("FW_API_URL") is not None


def main() -> None:
    # 1. `init_fireweave` is the single entry point (spec/modes.md) — it
    # validates the mode, builds the matching adapter, and brings the client
    # to READY.
    if USE_REMOTE:
        client = init_fireweave(
            mode="remote",
            api_url=os.environ.get("FW_API_URL", "http://127.0.0.1:3901"),
            api_key=os.environ.get("FW_PROJECT_API_KEY", "project-api-key_dev"),
        )
    else:
        # Local mode seeds a deterministic in-process map — no network, no
        # credentials. Great for tests and offline dev.
        client = init_fireweave(mode="local", local={"control_points": {"new-checkout": True}})

    # Stub fixture key when talking to the Fireweave remote protocol.
    bool_flag = "fw-bool-on" if USE_REMOTE else "new-checkout"

    # 2. Evaluate a boolean control point with a targeting context.
    ctx = EvaluationContext(targeting_key="user_42", attributes={"plan": "pro"})
    enabled = client.control_points.get_boolean_value(bool_flag, False, ctx)
    print(f"{bool_flag} enabled: {enabled}")

    # 3. Detailed resolution: value + variant + reason (upgrades from
    # get_boolean_value without restructuring the call).
    details = client.control_points.get_boolean_details(bool_flag, False, ctx)
    print(f"{bool_flag} details: value={details.value!r} variant={details.variant!r} reason={details.reason}")

    # 4. Register the durable targeting facts for this user — once per login,
    # not on every evaluation. Resolves ok=False rather than raising (it runs
    # in sign-in paths); the offline default and the --remote stub (which has
    # no /v1/targets/register route) both degrade the same, honest way.
    registered = client.register_target(
        "user_42", RegisterTargetOptions(kind="user", properties={"plan": "pro"})
    )
    suffix = "" if registered.ok else f" ({registered.error.kind.value})"
    print(f"register_target ok: {registered.ok}{suffix}")

    # 5. Clean shutdown.
    client.shutdown()
    print("shut down cleanly")


if __name__ == "__main__":
    main()
