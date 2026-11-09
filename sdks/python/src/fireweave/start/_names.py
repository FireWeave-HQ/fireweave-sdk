"""Every name the start profile reads, in one place, so the README, the
initialise skill and the error messages cannot drift apart.
"""

from __future__ import annotations

from typing import FrozenSet, Mapping, Tuple

#: Env vars the start profile reads. Explicit ``start()`` options always win.
ENV: Mapping[str, str] = {
    "key": "FIREWEAVE_KEY",
    "url": "FIREWEAVE_URL",
    "environment": "FIREWEAVE_ENV",
    "instance_id": "FIREWEAVE_INSTANCE_ID",
}

#: Fallback env-name sources for mode inference, after the ``environment``
#: option and FIREWEAVE_ENV. Python has no runtime-wide convention like
#: NODE_ENV, so APP_ENV is the only fallback (ENVIRONMENT and ENV are
#: deliberately not read).
ENVIRONMENT_FALLBACKS: Tuple[str, ...] = ("APP_ENV",)

#: Environment names that mean "local development" when no key is set.
#: Compared after trimming, case-insensitively.
DEV_ENVIRONMENTS: FrozenSet[str] = frozenset({"development", "dev", "local", "test"})

#: fw-server host for each release channel of this package.
CHANNEL_URLS: Mapping[str, str] = {
    "production": "https://app-server.fireweave.ai",
    "staging": "https://staging-app-server.fireweave.ai",
}

#: Hosts always allowed beside a custom endpoint, so local stacks keep working.
LOOPBACK_HOSTS: Tuple[str, ...] = ("localhost", "127.0.0.1", "::1")

#: The logger the default sink writes to. Looked up when a line is emitted,
#: never at import.
LOGGER_NAME = "fireweave.start"
