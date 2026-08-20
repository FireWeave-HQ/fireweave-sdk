"""infrastructure/ — concrete adapters (local/remote/in-memory) and the host
allowlist. Depends on `domain/` and `application/` (port definitions); never
imported by `domain/`, and imported by `application/` only from the
`mode.py` composition root.
"""
