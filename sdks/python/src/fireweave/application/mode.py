"""init_fireweave — the single SDK entry point (spec/modes.md).

`mode` is required and never inferred: a missing or mistyped credential must
fail loudly at boot, not silently fall back to local evaluation — that
failure mode looks like a green boot and a feature that never ramps. This
module's only job is to validate the initialisation-time contract and select
the matching adapter; nothing downstream branches on mode again
(spec/modes.md "Behaviour per mode" — both adapters implement the same
`BackendAdapter` port, so `FireweaveClient` / `FireweaveRuntime` stay
mode-blind).

Initialisation fails loudly (raises); reads on the returned client never do
(spec/control-points.md "initialise is the exception"). The validation
itself lives in `validate_init_options` (domain/validation.py), which
returns a `Validated` like every other validator — this module is what
converts a failed `Validated` into the RAISE spec/modes.md requires.

This is the SANCTIONED composition root (mirroring node's `application/mode.ts`):
the only file under `application/` allowed to import concrete
`infrastructure/adapters/*` — see `tests/guard/test_architecture_layers.py`.
"""

from __future__ import annotations

from typing import Any, Mapping

from ..domain.validation import validate_init_options
from ..infrastructure.adapters.local import FireweaveLocalAdapter
from ..infrastructure.adapters.remote import FireweaveRemoteAdapter
from ..infrastructure.hosts import assert_host_allowed
from .client import FireweaveClient
from .runtime import FireweaveRuntime

__all__ = ["init_fireweave"]


def _init_local(options: Mapping[str, Any]) -> FireweaveClient:
    local = options.get("local") or {}
    adapter = FireweaveLocalAdapter(
        local.get("control_points") or {},
        log=local.get("log"),
    )
    runtime = FireweaveRuntime(adapter)
    runtime.initialize()
    return FireweaveClient(runtime)


def _init_remote(options: Mapping[str, Any]) -> FireweaveClient:
    api_key = options["api_key"]
    api_url = options["api_url"]
    allowed_hosts = options.get("allowed_hosts")
    # `validate_init_options` (called by `init_fireweave`, below) has already
    # ruled out blank api_key/api_url by the time this runs — only the host
    # allowlist row remains to check here (spec/modes.md "apiUrl fails the
    # host allowlist"), against the CANONICAL default allowlist
    # (`infrastructure/hosts.DEFAULT_ALLOWED_HOSTS`) when the caller supplies
    # no override. This is the sanctioned entry point's gate; the adapter's
    # own `initialize()` carries a second, more permissive check (its own
    # hostname self-allowed) as a safety net for direct adapter construction
    # that bypasses `init_fireweave` entirely.
    assert_host_allowed(api_url, allowed_hosts)

    adapter = FireweaveRemoteAdapter(
        api_url=api_url,
        api_key=api_key,
        allowed_hosts=allowed_hosts,
        transport=options.get("transport"),
    )
    runtime = FireweaveRuntime(adapter)
    runtime.initialize()
    return FireweaveClient(runtime)


def init_fireweave(**options: Any) -> FireweaveClient:
    """Build the adapter matching ``mode`` and bring a :class:`FireweaveClient`
    to READY.

    Raises :class:`~fireweave.domain.errors.ConfigurationError` for every row
    of the initialisation-validation table (spec/modes.md):

    - ``mode`` absent or unrecognised
    - ``mode="remote"`` with ``api_key`` or ``api_url`` missing/blank
    - ``api_url`` fails the host allowlist
    - ``mode="local"`` with credentials supplied

    The first, second and fourth rows are `validate_init_options`'s job; the
    third is validated in `_init_remote`, before any adapter/network I/O
    happens.

    Usage::

        init_fireweave(mode="remote", api_key="...", api_url="https://app-server.fireweave.ai")
        init_fireweave(mode="local", local={"control_points": {"my-flag": True}})
    """
    validated = validate_init_options(options)
    if not validated.ok:
        raise validated.error
    valid_options = validated.value
    return _init_local(valid_options) if valid_options["mode"] == "local" else _init_remote(valid_options)
