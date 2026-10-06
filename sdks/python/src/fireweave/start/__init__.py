"""fireweave.start: FireWeave in one line (docs/adr/0012-start-profile.md).

::

    # src/fireweave_setup/control_points.py (the name is yours)
    from fireweave.start import define_control_points
    control_points = define_control_points({"new-checkout": {"local": True}})

    # the process entrypoint, first thing
    from fireweave.start import start
    from fireweave_setup.control_points import control_points
    start(control_points=control_points)

    # anywhere
    from fireweave import EvaluationContext
    from fireweave.start import fw
    if fw.control_points.get_boolean_value("new-checkout", False, EvaluationContext(user_id)):
        ...

This layer is built only on the top-level ``fireweave`` API; the core
(``init_fireweave`` and everything it exports) is unchanged, still reads no
environment, and does not import this package. Importing it reads no env,
does no I/O, starts no thread and creates no logger or lock.
"""

from ._build_info import SDK_CHANNEL, SDK_VERSION, SdkChannel
from ._facade import ControlPoints, Fireweave, fw
from ._control_points import ControlPointDefinition, ControlPointMap, define_control_points
from ._resolve import StartMode
from ._state import FireweaveStatus, reset_for_tests, start

__all__ = [
    "start",
    "fw",
    "define_control_points",
    "reset_for_tests",
    "SDK_VERSION",
    "SDK_CHANNEL",
    "Fireweave",
    "ControlPoints",
    "FireweaveStatus",
    "ControlPointDefinition",
    "ControlPointMap",
    "StartMode",
    "SdkChannel",
]
