"""``fw.instance_key()``: a stable targeting key for reads where the server
itself is the subject (cron, migrations, boot-time decisions). Request reads
still pass the user's id.

Sources, in order: ``start(instance_id=...)``, FIREWEAVE_INSTANCE_ID, then
``inst_`` plus a hash of the host name, then ``inst_`` plus a random id for
the life of the process. Nothing is written to disk: in a container the file
would not outlive the process anyway.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Callable, Optional

from ._env import EnvReader
from ._names import ENV

_FNV_OFFSET = 0xCBF29CE484222325
_FNV_PRIME = 0x100000001B3
_MASK64 = 0xFFFFFFFFFFFFFFFF


def fnv1a64(text: str) -> str:
    """FNV-1a 64-bit over UTF-8, as 16 hex digits. Same function as the Node
    start profile, so one host name gives one key in every SDK. Not a
    security hash."""
    value = _FNV_OFFSET
    for byte in text.encode("utf-8"):
        value ^= byte
        value = (value * _FNV_PRIME) & _MASK64
    return f"{value:016x}"


@dataclass(frozen=True)
class InstanceKey:
    value: str
    #: 'option' | 'FIREWEAVE_INSTANCE_ID' | 'host' | 'random'
    source: str


def derive_instance_key(
    option: Optional[str], read: EnvReader, host_name: Callable[[], Optional[str]]
) -> InstanceKey:
    if option is not None:
        return InstanceKey(option, "option")
    from_env = read(ENV["instance_id"])
    if from_env is not None:
        return InstanceKey(from_env, ENV["instance_id"])
    host = host_name()
    if host is not None:
        return InstanceKey(f"inst_{fnv1a64(host)}", "host")
    return InstanceKey(f"inst_{uuid.uuid4().hex}", "random")
