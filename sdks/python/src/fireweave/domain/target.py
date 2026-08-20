"""Target-registration vocabulary (spec/remote-register-target.schema.json)."""

from __future__ import annotations

from typing import Literal

__all__ = ["TargetKind"]

TargetKind = Literal["user", "device"]
