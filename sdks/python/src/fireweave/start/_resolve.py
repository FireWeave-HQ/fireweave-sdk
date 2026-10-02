"""Pure start-profile resolver: options + env + build info in, one resolved
config out. No I/O, no globals, no logging: every rule here is unit-tested
through :func:`resolve_start` alone.

Precedence for every value: explicit ``start()`` option, then FIREWEAVE_*
env, then the legacy FW_* name (one warning), then the default. Reads are
lazy: a source is read only if every earlier source was unset.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional, Sequence, Tuple
from urllib.parse import urlparse

from fireweave import ConfigurationError, assert_host_allowed

from ._env import EnvReader
from ._flags import FlagDefinition, normalize_flags
from ._names import (
    CHANNEL_URLS,
    DEV_ENVIRONMENTS,
    ENV,
    ENVIRONMENT_FALLBACKS,
    LEGACY_ENV,
    LOOPBACK_HOSTS,
    RETIRED_ENVIRONMENT_NAME,
)

StartMode = Literal["remote", "local"]

_VENDOR_KEY = re.compile(r"^ph[a-z]_")


@dataclass(frozen=True)
class ResolvedStart:
    mode: StartMode
    #: Why this mode: 'option' (the mode option), 'key' (a key is set) or
    #: 'environment' (a development environment name).
    mode_source: str
    #: Where the key came from ('start(key=...)', 'FIREWEAVE_KEY', ...), or 'none'.
    key_source: str
    channel: str
    sdk_version: str
    flags: Dict[str, FlagDefinition] = field(default_factory=dict)
    #: Remote only.
    url: Optional[str] = None
    url_source: Optional[str] = None
    allowed_hosts: Optional[Tuple[str, ...]] = None
    #: Remote only. Never logged, printed or shown by repr().
    key: Optional[str] = field(default=None, repr=False)
    #: Set when the environment name was consulted (no key, no mode option).
    environment: Optional[str] = None
    environment_source: Optional[str] = None
    #: Lines to log once each: legacy names, an ignored key.
    warnings: Tuple[str, ...] = ()


@dataclass(frozen=True)
class _Sourced:
    value: str
    source: str


def _config_error(message: str) -> ConfigurationError:
    return ConfigurationError(message, init_fatal=True)


def _option_string(value: Any, name: str) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str):
        raise _config_error(f"[fireweave] start({name}=...) must be a string.")
    return value.strip() or None


def _pick(
    option: Optional[str],
    option_name: str,
    names: Sequence[str],
    legacy: Sequence[str],
    read: EnvReader,
    warnings: List[str],
    replacement: str,
) -> Optional[_Sourced]:
    """First non-empty of: the option, then each env name, then each legacy name."""
    if option is not None:
        return _Sourced(option, f"start({option_name}=...)")
    for name in names:
        value = read(name)
        if value is not None:
            return _Sourced(value, name)
    for name in legacy:
        value = read(name)
        if value is not None:
            warnings.append(
                f"[fireweave] {name} is a legacy name and will stop being read in 3.0.0. "
                f"Rename it to {replacement}; the value does not change."
            )
            return _Sourced(value, name)
    return None


def _check_key_family(key: str, source: str) -> None:
    """Key family check, before any request. Messages name the source, never
    the value. The core redactor masks analytics-vendor prefixes, so the
    message says "analytics vendor key" instead of quoting one."""
    if key.startswith("fw_public_"):
        raise _config_error(
            f"[fireweave] The key from {source} is a browser key (fw_public_...). Server apps need a "
            "project key (project-api-key_...) from Project settings, API keys."
        )
    if _VENDOR_KEY.match(key):
        raise _config_error(
            f"[fireweave] The key from {source} is an analytics vendor key, not a FireWeave project key. "
            "Use the project key (project-api-key_...)."
        )
    if key.startswith("fw_org_") or key.startswith("cli_at_"):
        raise _config_error(
            f"[fireweave] The key from {source} is an organisation or CLI token, not a project key. "
            "Use the project key (project-api-key_...)."
        )


def _resolve_url(url_option: Optional[str], read: EnvReader, channel: str, warnings: List[str]) -> Dict[str, Any]:
    picked = _pick(url_option, "url", [ENV["url"]], LEGACY_ENV["url"], read, warnings, ENV["url"])
    if picked is None:
        # Both channel hosts are in the core's DEFAULT_ALLOWED_HOSTS, so no
        # custom allowlist is passed.
        return {"url": CHANNEL_URLS[channel], "url_source": f"SDK channel ({channel})"}
    url = picked.value.rstrip("/")
    invalid = f"[fireweave] The endpoint from {picked.source} is not a valid http(s) URL."
    try:
        parsed = urlparse(url)
        hostname = parsed.hostname
    except ValueError:
        raise _config_error(invalid) from None
    if parsed.scheme not in ("http", "https") or not hostname:
        raise _config_error(invalid)
    allowed = (hostname,) + tuple(h for h in LOOPBACK_HOSTS if h != hostname)
    try:
        assert_host_allowed(url, allowed)
    except ConfigurationError:
        raise _config_error(
            f"[fireweave] The endpoint from {picked.source} must use https (http is allowed only for localhost)."
        ) from None
    return {"url": url, "url_source": picked.source, "allowed_hosts": allowed}


def _resolve_key(key_option: Optional[str], read: EnvReader, warnings: List[str]) -> Optional[_Sourced]:
    picked = _pick(key_option, "key", [ENV["key"]], LEGACY_ENV["key"], read, warnings, ENV["key"])
    if picked is not None:
        _check_key_family(picked.value, picked.source)
    return picked


def _no_key_error(env: Optional[_Sourced], read: EnvReader) -> ConfigurationError:
    names = [ENV["environment"], *ENVIRONMENT_FALLBACKS]
    checked = ", ".join(names[:-1]) + f" and {names[-1]}" if len(names) > 1 else names[0]
    if env is None:
        where = f"no environment name is set (checked the environment option, {checked})"
    else:
        where = f"the environment is {env.value!r} (from {env.source}), which is not a development name"
    retired = (
        f" {RETIRED_ENVIRONMENT_NAME} is no longer read; rename it to {ENV['environment']}."
        if env is None and read(RETIRED_ENVIRONMENT_NAME) is not None
        else ""
    )
    return _config_error(
        f"[fireweave] {ENV['key']} is not set and {where}. Set {ENV['key']} to the project's server key, "
        f"or for local development set {ENV['environment']}=development or call start(mode='local').{retired}"
    )


def resolve_start(
    *,
    read: EnvReader,
    sdk_version: str,
    channel: str,
    mode: Any = None,
    environment: Any = None,
    url: Any = None,
    key: Any = None,
    flags: Any = None,
) -> ResolvedStart:
    """Resolve ``start()`` options against the environment.

    Raises ConfigurationError (init_fatal) naming the option or variable at
    fault, never its value.
    """
    warnings: List[str] = []
    normalized = normalize_flags(flags)
    base: Dict[str, Any] = {"flags": normalized, "channel": channel, "sdk_version": sdk_version}

    if mode is not None and mode not in ("remote", "local"):
        raise _config_error("[fireweave] start(mode=...) must be 'remote' or 'local'.")
    key_option = _option_string(key, "key")
    url_option = _option_string(url, "url")
    environment_option = _option_string(environment, "environment")

    if mode == "local":
        # The key is ignored. Look only to warn.
        ignored = "start(key=...)" if key_option is not None else next(
            (name for name in (ENV["key"], *LEGACY_ENV["key"]) if read(name) is not None), None
        )
        if ignored is not None:
            warnings.append(
                f"[fireweave] start(mode='local') ignores the key from {ignored}; nothing is sent to fw-server."
            )
        return ResolvedStart(mode="local", mode_source="option", key_source="none", warnings=tuple(warnings), **base)

    picked_key = _resolve_key(key_option, read, warnings)

    if mode == "remote" or picked_key is not None:
        if picked_key is None:
            raise _config_error(
                f"[fireweave] start(mode='remote') needs a key. Set {ENV['key']} or pass start(key=...)."
            )
        endpoint = _resolve_url(url_option, read, channel, warnings)
        return ResolvedStart(
            mode="remote",
            mode_source="option" if mode == "remote" else "key",
            key=picked_key.value,
            key_source=picked_key.source,
            warnings=tuple(warnings),
            **endpoint,
            **base,
        )

    env = _pick(environment_option, "environment", [ENV["environment"], *ENVIRONMENT_FALLBACKS], [], read, [], "")
    if env is not None and env.value.lower() in DEV_ENVIRONMENTS:
        return ResolvedStart(
            mode="local",
            mode_source="environment",
            key_source="none",
            environment=env.value,
            environment_source=env.source,
            warnings=tuple(warnings),
            **base,
        )
    raise _no_key_error(env, read)
