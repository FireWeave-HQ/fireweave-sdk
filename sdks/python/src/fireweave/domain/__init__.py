"""domain/ — pure, dependency-free layer (spec/control-points.md, spec/modes.md).

Imports nothing from ``application/`` or ``infrastructure/`` (enforced by
``tests/guard/test_architecture_layers.py``). Every module here is safe to
port to another language's validation layer without dragging adapters or
runtime wiring along.
"""
