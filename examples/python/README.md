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

## `fastapi_app.py` — FastAPI service

Lifespan-managed client (deterministic shutdown), per-request targeting
context, boolean gating, detailed-resolution endpoint, health signals.

```bash
../../sdks/python/.venv/bin/pip install fastapi uvicorn httpx
../../sdks/python/.venv/bin/uvicorn fastapi_app:app
curl 'http://127.0.0.1:8000/checkout?user_id=user_42&tier=gold'
```

## `test_fastapi_app.py` — in-memory testing

Shows dependency-injecting `InMemoryAdapter` into the app for hermetic tests.

```bash
../../sdks/python/.venv/bin/pytest test_fastapi_app.py
```
