"""This distribution's version and release channel.

The start profile defaults its fw-server host from the channel the installed
package was released on (docs/adr/0012-start-profile.md, rule 3).
Staging builds are ``X.Y.ZrcN`` on PyPI (tools/release/version.sh), and the
channel is read from the version itself: any PEP 440 pre-release or dev
release is staging (the pre-rename ``3.0.0a1`` on TestPyPI included),
anything else is production. Nothing is stamped at release time.
"""

from __future__ import annotations

import re
from typing import Literal

import fireweave

SdkChannel = Literal["staging", "production"]

# PEP 440: the release segment (with optional epoch), then whatever follows.
# A pre-release (aN, bN, rcN and the spellings PEP 440 normalises to them) or
# a dev release (.devN) after it makes the version a prerelease; a post
# release or a local label (+...) does not.
_RELEASE = re.compile(r"^v?(?:\d+!)?\d+(?:\.\d+)*", re.IGNORECASE)
_PRE_OR_DEV = re.compile(r"^[-_.]?(?:a|b|c|rc|alpha|beta|pre|preview|dev)(?:[-_.]?\d+)?(?![a-z])", re.IGNORECASE)
_POST = re.compile(r"^(?:-\d+|[-_.]?(?:post|rev|r)(?:[-_.]?\d+)?)", re.IGNORECASE)


def channel_for_version(version: str) -> SdkChannel:
    """``'staging'`` iff ``version`` is a PEP 440 prerelease (``2.4.0a1``,
    ``2.4.0rc1``, ``2.4.0.dev3``); otherwise ``'production'``. An unparseable
    version is production: the production host is the safe default for a
    build nobody can place."""
    public = version.strip().split("+", 1)[0]
    release = _RELEASE.match(public)
    if release is None:
        return "production"
    rest = public[release.end():]
    # A post release may sit between the release and a dev segment (1.0.post1.dev2).
    post = _POST.match(rest)
    if post is not None and not _PRE_OR_DEV.match(rest):
        rest = rest[post.end():]
    return "staging" if _PRE_OR_DEV.match(rest) else "production"


def _installed_version() -> str:
    try:
        from importlib.metadata import PackageNotFoundError, version

        try:
            return version("fireweave")
        except PackageNotFoundError:
            pass
    except ImportError:  # pragma: no cover - stdlib on every supported Python
        pass
    return fireweave.__version__


#: The installed distribution's version (``fireweave.__version__`` when the
#: distribution metadata is unavailable, e.g. running from a source tree).
SDK_VERSION: str = _installed_version()

#: The release channel ``SDK_VERSION`` belongs to.
SDK_CHANNEL: SdkChannel = channel_for_version(SDK_VERSION)
