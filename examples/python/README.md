# Fireweave Python examples

All examples are **offline by default** (in-memory adapter). Set
`FIREWEAVE_POSTHOG_KEY=phc_...` to switch to the PostHog-backed adapter.

## Setup

```bash
cd sdks/python && python3 -m venv .venv && .venv/bin/pip install -e '.[posthog,openfeature]'
cd ../../examples/python
```

## `service.py` — plain service script

OpenFeature provider registration, boolean eval, detailed resolution,
targeting context, `releases.set_context` + `signals.record_health`,
exposures, and clean shutdown.

```bash
../../sdks/python/.venv/bin/python service.py
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
