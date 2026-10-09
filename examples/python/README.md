# Fireweave Python examples

`service.py` is **offline by default** (`mode="local"`, no network). Pass
`--remote` (or set `FW_API_URL`) to switch to `mode="remote"` against
fw-server (or the local test-server stub).

## Setup

```bash
cd sdks/python && python3 -m venv .venv && .venv/bin/pip install -e .
cd ../../examples/python
```

## `service.py` — plain service script

`init_fireweave`, boolean control-point read + detailed resolution, a
targeting context, `register_target`, and clean shutdown.

```bash
../../sdks/python/.venv/bin/python service.py
FW_API_URL=... FW_PROJECT_API_KEY=... ../../sdks/python/.venv/bin/python service.py --remote
```
