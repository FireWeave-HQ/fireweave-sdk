"""``start()`` and the process-wide singleton behind ``fw``.

One slot per process. ``start()`` is synchronous and does no network I/O
(``init_fireweave`` does none either), so the client is ready when it
returns: it resolves and validates everything up front, raises
ConfigurationError for bad config, then hands off to the unchanged core
``init_fireweave()``.

A read before any ``start()`` starts FireWeave right there, from the process
environment alone (Python has no event-loop turn to defer it to, unlike the
Node profile). That start is provisional: the first explicit ``start()``
afterwards replaces it once, with a warning, so an entrypoint that calls
``start()`` after some module read a flag at import time still wins. The
replaced client is not shut down, so a read racing the swap never sees
AlreadyClosed. A failed implicit start installs a client whose runtime is
FATAL: reads return their default (an ERROR decision with the Configuration
error for the details forms), and nothing raises.

After ``os.fork()`` the child rebuilds its client from the stored resolved
config (cheap: no I/O, no thread), so a runtime lock held by another thread
at fork time cannot deadlock the child's first read.

Writes take the lock; reads do one attribute load. Nothing is logged while
the lock is held.
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple, Union
from urllib.parse import urlparse

from fireweave import (
    ConfigurationError,
    FireweaveClient,
    FireweaveError,
    FireweaveRuntime,
    InternalError,
    init_fireweave,
    redact_secrets,
)

from ._build_info import SDK_CHANNEL, SDK_VERSION
from ._env import EnvReader, env_from_mapping, host_name, process_env
from ._flags import FlagDefinition, flags_file, to_local_control_points
from ._instance import InstanceKey, derive_instance_key
from ._names import LOGGER_NAME
from ._resolve import ResolvedStart, StartMode, resolve_start

LogSink = Union[Callable[[str], None], logging.Logger, logging.LoggerAdapter]


@dataclass(frozen=True)
class FireweaveStatus:
    """What ``start()`` decided. Never includes the key."""

    #: 'unstarted' | 'ready' | 'failed' | 'shutdown'
    state: str
    channel: str
    sdk_version: str
    #: 'explicit' (a start() call) or 'implicit' (a read before start()).
    started_by: Optional[str] = None
    mode: Optional[StartMode] = None
    #: 'option' | 'key' | 'environment'
    mode_source: Optional[str] = None
    #: fw-server host name only: never a path or a credential.
    host: Optional[str] = None
    endpoint_source: Optional[str] = None
    key_source: Optional[str] = None
    environment: Optional[str] = None
    flag_count: Optional[int] = None
    #: Why start failed, when it did. Already redacted.
    error: Optional[str] = None


class _Slot:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.state = "unstarted"
        self.implicit = False
        self.signature: Optional[Tuple[Any, ...]] = None
        self.resolved: Optional[ResolvedStart] = None
        self.client: Optional[FireweaveClient] = None
        self.error: Optional[FireweaveError] = None
        self.read: Optional[EnvReader] = None
        self.transport: Any = None
        self.instance_id_option: Optional[str] = None
        self.instance: Optional[InstanceKey] = None
        self.flags_file: Optional[str] = None
        self.log: Optional[LogSink] = None
        self.pid: Optional[int] = None
        self.warned: set = set()


_S = _Slot()

# Created on first use, not at import (gevent's monkey.patch_all() may run
# after `import fireweave.start`), and re-created in a forked child.
_LOCK_BOX: Dict[str, Any] = {}
_FORK_HOOK: List[bool] = []

_Message = Tuple[int, str]


def _lock() -> Any:
    lock = _LOCK_BOX.get("lock")
    if lock is None:
        lock = _LOCK_BOX.setdefault("lock", threading.Lock())
    return lock


# -- logging -------------------------------------------------------------------


def _emit(level: int, line: str) -> None:
    text = redact_secrets(line) or line
    sink = _S.log
    try:
        if sink is None:
            logging.getLogger(LOGGER_NAME).log(level, text)
        elif isinstance(sink, (logging.Logger, logging.LoggerAdapter)):
            sink.log(level, text)
        else:
            sink(text)
    except Exception:
        pass  # a broken log sink never breaks start() or a read


def _flush(messages: List[_Message]) -> None:
    """Log each line once per process. Called with the lock released: the
    once-check takes it briefly, the sink never runs under it."""
    if not messages:
        return
    with _lock():
        fresh = []
        for level, line in messages:
            if line not in _S.warned:
                _S.warned.add(line)
                fresh.append((level, line))
    for level, line in fresh:
        _emit(level, line)


def warn_once(line: str, level: int = logging.WARNING) -> None:
    _flush([(level, line)])


def _local_trace(line: str) -> None:
    """The core local adapter's registerTarget trace. Without a log option it
    keeps the core's own default (print), so local mode stays visible."""
    if _S.log is None:
        print(line)
    else:
        _emit(logging.INFO, line)


def _validate_log(log: Any) -> Optional[LogSink]:
    if log is None or isinstance(log, (logging.Logger, logging.LoggerAdapter)) or callable(log):
        return log
    raise ConfigurationError("[fireweave] start(log=...) must be a callable or a logging.Logger.", init_fatal=True)


# -- building clients ------------------------------------------------------------


class _FailedStartAdapter:
    """Adapter for a start that failed: initialize() raises the start error,
    so the core runtime is FATAL and every read degrades through the core's
    own lifecycle gate (default value, ERROR decision, Configuration kind)."""

    backend_name = "other"

    def __init__(self, error: FireweaveError) -> None:
        self._error = error

    def initialize(self) -> None:
        raise self._error

    def resolve(self, flag_key: str, context: Any) -> Any:
        raise self._error

    def shutdown(self, timeout_ms: int) -> None:
        return None


def _failed_client(error: FireweaveError) -> FireweaveClient:
    runtime = FireweaveRuntime(_FailedStartAdapter(error))
    try:
        runtime.initialize()
    except FireweaveError:
        pass
    return FireweaveClient(runtime)


def _build_client(r: ResolvedStart, transport: Any) -> FireweaveClient:
    if r.mode == "local":
        return init_fireweave(
            mode="local",
            local={"control_points": to_local_control_points(r.flags), "log": _local_trace},
        )
    options: Dict[str, Any] = {"mode": "remote", "api_key": r.key, "api_url": r.url}
    if r.allowed_hosts is not None:
        options["allowed_hosts"] = r.allowed_hosts
    if transport is not None:
        options["transport"] = transport
    return init_fireweave(**options)


def _signature(r: ResolvedStart, instance_id: Optional[str]) -> Tuple[Any, ...]:
    return (
        r.mode,
        r.url,
        hashlib.sha256(r.key.encode("utf-8")).hexdigest() if r.key is not None else None,
        r.allowed_hosts,
        instance_id,
        # Local values only matter in local mode; remote ignores them, so an
        # env-only implicit start followed by start(flags=...) under a key is
        # not a different configuration.
        tuple(sorted(to_local_control_points(r.flags).items())) if r.mode == "local" else None,
    )


def _local_banner(r: ResolvedStart) -> _Message:
    n = len(r.flags)
    served = f"Serving {n} flag{'' if n == 1 else 's'} from your flags object; nothing is sent to fw-server."
    if r.mode_source == "option":
        return logging.INFO, f"[fireweave:local] Local mode (start(mode='local')). {served}"
    # Inferred from an environment name: WARNING, so it shows at Python's
    # default logging config (logging's last-resort handler drops INFO).
    return (
        logging.WARNING,
        f"[fireweave:local] Local mode (no FIREWEAVE_KEY; environment {r.environment!r} from "
        f"{r.environment_source}). {served}",
    )


def _install(
    r: ResolvedStart,
    signature: Tuple[Any, ...],
    client: FireweaveClient,
    *,
    implicit: bool,
    read: EnvReader,
    transport: Any,
    flags_source: Any,
) -> List[_Message]:
    """Under the lock: make ``client`` the process client. Returns the lines
    to log once the lock is released."""
    s = _S
    s.state = "ready"
    s.implicit = implicit
    s.signature = signature
    s.resolved = r
    s.client = client
    s.error = None
    s.read = read
    s.transport = transport
    s.flags_file = flags_file(flags_source)
    s.pid = os.getpid()
    _register_fork_hook()
    messages: List[_Message] = [(logging.WARNING, w) for w in r.warnings]
    if r.mode == "local":
        messages.append(_local_banner(r))
    return messages


# -- start -----------------------------------------------------------------------


def start(
    *,
    flags: Optional[Mapping[str, FlagDefinition]] = None,
    mode: Optional[StartMode] = None,
    environment: Optional[str] = None,
    url: Optional[str] = None,
    key: Optional[str] = None,
    instance_id: Optional[str] = None,
    env: Optional[Mapping[str, Any]] = None,
    log: Optional[LogSink] = None,
    transport: Any = None,
) -> None:
    """Start FireWeave for this process. Call it once, first thing in each
    process entrypoint. Every option is keyword-only and optional; see the
    README's options table.

    Raises ConfigurationError (kind ``Configuration``) naming the option or
    variable at fault, never its value. A second identical call is a no-op;
    a different one raises.

    ``env`` is read instead of ``os.environ`` (tests). ``log`` is a callable
    taking one line, or a ``logging.Logger`` (default: the
    ``fireweave.start`` logger). ``transport`` replaces the remote adapter's
    HTTP call (tests only). None of those three is part of the idempotency
    check.
    """
    sink = _validate_log(log)
    if instance_id is not None and not isinstance(instance_id, str):
        raise ConfigurationError("[fireweave] start(instance_id=...) must be a string.", init_fatal=True)
    instance_option = instance_id.strip() or None if instance_id is not None else None
    if env is not None and not isinstance(env, Mapping):
        raise ConfigurationError("[fireweave] start(env=...) must be a mapping.", init_fatal=True)
    read = env_from_mapping(env) if env is not None else process_env()
    resolved = resolve_start(
        read=read,
        sdk_version=SDK_VERSION,
        channel=SDK_CHANNEL,
        mode=mode,
        environment=environment,
        url=url,
        key=key,
        flags=flags,
    )
    signature = _signature(resolved, instance_option)

    check_fork()
    with _lock():
        s = _S
        if s.state == "ready" and not s.implicit:
            if signature == s.signature:
                return
            raise ConfigurationError(
                "[fireweave] start() was already called with a different configuration. "
                "Call start() once per process, first thing in its entrypoint.",
                init_fatal=True,
            )
        if instance_option is not None and s.instance is not None and s.instance.value != instance_option:
            raise ConfigurationError(
                "[fireweave] start(instance_id=...) differs from the instance_key() already handed out. "
                "Pass instance_id on the first start().",
                init_fatal=True,
            )
        replacing = s.state == "ready" and s.implicit
        if replacing and signature == s.signature:
            # The implicit start already did exactly this: adopt it.
            s.implicit = False
            messages: List[_Message] = []
        else:
            client = _build_client(resolved, transport)  # raises before any state changes
            messages = _install(
                resolved, signature, client, implicit=False, read=read, transport=transport, flags_source=flags
            )
            if replacing:
                messages.append(
                    (
                        logging.WARNING,
                        "[fireweave] start() replaced the configuration FireWeave had started from the "
                        "environment alone, because a control point was read before start() ran. Reads "
                        "before this point used the environment only; call start() first in your entrypoint.",
                    )
                )
        if sink is not None:
            s.log = sink
        if instance_option is not None:
            s.instance_id_option = instance_option
    _flush(messages)


def current_client() -> FireweaveClient:
    """The process client, starting FireWeave from the environment if no
    start() has run. Never raises for configuration: a failed start yields a
    FATAL client whose reads serve defaults."""
    check_fork()
    client = _S.client
    if client is not None:
        return client
    return _implicit_start()


def _implicit_start() -> FireweaveClient:
    messages: List[_Message] = []
    with _lock():
        s = _S
        if s.client is not None:
            return s.client
        read = process_env()
        try:
            resolved = resolve_start(read=read, sdk_version=SDK_VERSION, channel=SDK_CHANNEL)
            client = _build_client(resolved, None)
        except Exception as exc:
            error = exc if isinstance(exc, FireweaveError) else InternalError("start failed")
            if error is not exc:
                error.__cause__ = exc
            s.state = "failed"
            s.implicit = True
            s.error = error
            s.read = read
            s.client = _failed_client(error)
            s.pid = os.getpid()
            _register_fork_hook()
            messages.append(
                (logging.ERROR, f"{error.message} (FireWeave was not started; reads serve their defaults.)")
            )
        else:
            messages = _install(
                resolved,
                _signature(resolved, None),
                client,
                implicit=True,
                read=read,
                transport=None,
                flags_source=None,
            )
            host = urlparse(resolved.url).hostname if resolved.url else None
            messages.append(
                (
                    logging.WARNING,
                    f"[fireweave] A control point was read before start() ran in this process "
                    f"(pid {os.getpid()}), so FireWeave started from the environment alone: "
                    f"{resolved.mode} mode{f', host {host}' if host else ''}. Options passed to start() "
                    "elsewhere do not apply here; call start() first in the entrypoint.",
                )
            )
        client = s.client
    _flush(messages)
    return client


# -- fork ------------------------------------------------------------------------


def _register_fork_hook() -> None:
    """Under the lock, once per process."""
    if not _FORK_HOOK and hasattr(os, "register_at_fork"):
        _FORK_HOOK.append(True)
        os.register_at_fork(after_in_child=_after_fork_in_child)


def check_fork() -> None:
    """Before taking the lock: catches a fork that bypassed the at-fork hook
    (a cheap pid compare)."""
    if _S.pid is not None and _S.pid != os.getpid():
        _after_fork_in_child()


def _after_fork_in_child() -> None:
    """In a forked child: a fresh lock (the parent's may have been held at
    fork time), then a fresh client built from the stored config."""
    if _S.pid is None or _S.pid == os.getpid():
        return
    _LOCK_BOX["lock"] = threading.Lock()
    with _lock():
        if _S.pid != os.getpid():
            _rebuild_client()


def _rebuild_client() -> None:
    s = _S
    s.pid = os.getpid()
    if s.state == "ready" and s.resolved is not None:
        try:
            s.client = _build_client(s.resolved, s.transport)
        except Exception as exc:
            error = exc if isinstance(exc, FireweaveError) else InternalError("start failed")
            s.state, s.error, s.client = "failed", error, _failed_client(error)
    elif s.state == "failed" and s.error is not None:
        s.client = _failed_client(s.error)
    # 'shutdown' keeps its closed client: no restart behind the app's back.


# -- the rest of fw ----------------------------------------------------------------


def instance_key() -> str:
    """Computed once per process; never raises; writes nothing."""
    check_fork()
    with _lock():
        s = _S
        if s.instance is None:
            s.instance = derive_instance_key(s.instance_id_option, s.read or process_env(), host_name)
        return s.instance.value


def local_flags() -> Optional[Tuple[Mapping[str, FlagDefinition], Optional[str]]]:
    """In local mode: the flags object and the file that declared it."""
    r = _S.resolved
    if r is None or r.mode != "local" or _S.state != "ready":
        return None
    return r.flags, _S.flags_file


def current_status() -> FireweaveStatus:
    s = _S
    r = s.resolved
    fields: Dict[str, Any] = {}
    if s.state != "unstarted":
        fields["started_by"] = "implicit" if s.implicit else "explicit"
    if r is not None:
        fields.update(
            mode=r.mode,
            mode_source=r.mode_source,
            key_source=r.key_source,
            flag_count=len(r.flags),
            environment=r.environment,
        )
        if r.url is not None:
            fields.update(host=urlparse(r.url).hostname, endpoint_source=r.url_source)
    if s.error is not None:
        fields["error"] = s.error.message
    return FireweaveStatus(
        state=s.state,
        channel=r.channel if r is not None else SDK_CHANNEL,
        sdk_version=r.sdk_version if r is not None else SDK_VERSION,
        **fields,
    )


def shutdown() -> None:
    """Flush and close the process client. A later start() begins fresh;
    reads in between serve their defaults (AlreadyClosed). Never raises."""
    check_fork()
    with _lock():
        client = _S.client
        if client is not None:
            _S.state = "shutdown"
    if client is not None:
        client.shutdown()


def reset_for_tests() -> None:
    """Test only: shut down and forget the singleton (including the
    warned-once lines), so the next start() or read begins fresh."""
    with _lock():
        client = _S.client
        _S.reset()
    if client is not None:
        try:
            client.shutdown()
        except Exception:
            pass
