# PostHog Protocol Test Server

Local stub of the PostHog server-side protocol used by Fireweave adapter integration tests. **Spec correctness > full implementation** — responses must match the shapes adapters rely on; do not reimplement PostHog evaluation logic.

## Purpose

- Give Python/Java (no transport injection) a `host=` target.
- Exercise Node `fetch` / Go `Transport` injection against deterministic HTTP.
- Drive fault modes referenced by `contracts/faults/*` and adapter I&T.

## Endpoints (minimum)

| Method | Path | Role |
| --- | --- | --- |
| `POST` | `/flags?v=2` | Remote evaluation snapshot (`reasons`, `requestId`, `quotaLimited`) |
| `POST` | `/flags/?v=2` | Same (trailing-slash tolerant) |
| `GET` | `/api/feature_flag/local_evaluation?token=…` | Local-eval **definitions poll** (shape under `fixtures/definitions.json`) |
| `POST` | `/batch/` | Event capture batch (`$feature_flag_called`, custom events) |
| `GET` | `/health` | Liveness for harness readiness |

Optional aliases may be added if pinned PostHog SDKs call slightly different paths; record them in `implementation/PATHS.md` when discovered — do not guess ahead of pins.

## Auth (stub)

- Project key: request body / query `api_key` or `token` matching configured `phc_*` test key → accept.
- Secret key for definitions: `Authorization: Bearer phs_…` or `phx_…` → accept when configured.
- Wrong/missing credentials → fault profile `401` (see fault modes).

**Never** log raw keys; redact in stub access logs.

## `/flags?v=2` response contract

Success body (see `fixtures/flags-v2-success.json`):

```json
{
  "flags": {
    "fw-bool-on": {
      "key": "fw-bool-on",
      "enabled": true,
      "variant": null,
      "reason": {
        "code": "condition_match",
        "condition_index": 0,
        "description": "Condition set 1 matched"
      },
      "metadata": {
        "id": 1,
        "version": 1,
        "payload": null
      }
    }
  },
  "errorsWhileComputingFlags": false,
  "requestId": "00000000-0000-4000-8000-000000000001",
  "quotaLimited": null
}
```

Notes:

- `requestId` in fixtures is **fixed** for determinism; production PostHog uses random UUIDs. Contract comparators **exclude** `requestId`.
- Multivariate: set `variant` to the string variant; `enabled` true.
- Boolean off: `enabled` false, `variant` null.
- Quota soft-limit: HTTP 200 + `"flags": {}` + `"quotaLimited": ["feature_flags"]` (`fixtures/flags-v2-quota-limited.json`).

## Definitions poll contract

Return a deterministic definitions document (`fixtures/definitions.json`) with stable `version` integers. Change detection in SDKs is version-based — bump `version` only in explicit “config changed” fixtures.

## Event batch contract

Accept `POST /batch/` JSON; respond `{"status":1}` on success. Persist accepted events in-memory for harness assertions (`GET /_test/events` — test-only).

## Fault modes

Activated via:

1. Header `X-Fw-Test-Fault: <mode>` on the request, or
2. Query `?fault=<mode>`, or
3. Test admin `POST /_test/fault` with `{"mode":…, "ttlRequests": N}`.

| Mode | Behavior |
| --- | --- |
| `none` | Normal fixture response |
| `delay` | Sleep `delayMs` (default 10000) before response |
| `401` | HTTP 401 JSON `{"type":"authentication_error","code":"invalid_api_key"}` |
| `429` | HTTP 429 + `Retry-After: 1` |
| `500` | HTTP 500 `{"type":"server_error"}` |
| `truncated` | Start writing body, then close socket mid-stream |
| `invalid_json` | HTTP 200, body `{not-json` |
| `quota_limited` | HTTP 200 + empty flags + `quotaLimited` |
| `offline` | Connection refused / bind removed (harness-level; stub exits or rejects accept) |

Faults can be scoped: `applyTo=flags|definitions|batch|all` (default `all`).

## Determinism

- Fixed `requestId` and definition versions in fixtures.
- No wall-clock in response bodies (put times only in excluded debug headers if needed).
- Stable JSON key ordering in golden fixtures (pretty-printed, sorted where practical).

## Relationship to `contracts/`

| Layer | Uses test-server? |
| --- | --- |
| JSON contract fixtures (in-memory adapter) | No (default) |
| Adapter integration / faults requiring HTTP | Yes |
| OpenFeature Appendix B Gherkin | No (in-memory) |

## Implementation plan

See [`implementation/PLAN.md`](./implementation/PLAN.md). Language agents must not block on a complete stub — a minimal `/flags?v=2` + fault header is enough for the first adapter I&T slice.
