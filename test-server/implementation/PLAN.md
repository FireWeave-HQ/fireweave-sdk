# test-server Implementation Plan

**Priority:** protocol shape correctness over feature completeness.  
**Non-goals:** real cohort matching, GeoIP, billing, OAuth, UI.

## Language / runtime

Ship a single stub process (recommended: **Go** or **Node**) listening on `127.0.0.1:3901` by default. All four SDK harnesses speak HTTP; one binary is enough.

Suggested layout when implemented:

```
test-server/
  README.md
  fixtures/           # golden bodies (this PR)
  implementation/
    PLAN.md           # this file
    PATHS.md          # filled when SDK pins reveal exact paths
    cmd/test-server/  # future main
    internal/httpapi/
    internal/faults/
    internal/store/
```

Do **not** block Phase 2 language work on completing `cmd/` — fixtures + this plan are the Phase 2 Agent E exit for test-server.

## Milestone 1 — Flags only (unblocks remote-eval I&T)

1. `POST /flags?v=2` (and `/flags/?v=2`)
2. Validate presence of project API key field (accept configured test key only).
3. Return `fixtures/flags-v2-success.json` keyed by request profile, or filter `flagKeys` if present.
4. Honor fault header/query: `delay`, `401`, `429`, `500`, `invalid_json`, `quota_limited`, `truncated`.
5. `GET /health` → `{"ok":true}`.

Acceptance: Node/Go adapter can evaluate `fw-bool-on` against the stub; fault fixtures in `contracts/faults/*` that need HTTP can run.

## Milestone 2 — Definitions poll (local-eval I&T)

1. Implement the definitions route actually called by pinned SDKs (record in `PATHS.md`).
2. Serve `fixtures/definitions.json`.
3. Require secret key; `401` on missing/wrong.
4. Support fault scope `applyTo=definitions`.

Acceptance: local-eval cold-start + stale-cache adapter tests can run.

## Milestone 3 — Batch / exposures

1. `POST /batch/` → `fixtures/batch-accept.json`.
2. Store events in memory; `GET /_test/events` returns deterministic list (sorted by event uuid if provided, else insert order).
3. Fault scopes for batch.

Acceptance: exposure flush integration assertions.

## Milestone 4 — Admin control plane (harness ergonomics)

| Endpoint | Body | Effect |
| --- | --- | --- |
| `POST /_test/fault` | `{"mode","delayMs","ttlRequests","applyTo"}` | Arm fault |
| `POST /_test/flags` | flags v2 JSON | Replace success body |
| `POST /_test/definitions` | definitions JSON | Replace definitions |
| `POST /_test/reset` | `{}` | Clear faults, events, restore default fixtures |

## Fault implementation notes

| Mode | Implementation sketch |
| --- | --- |
| `delay` | `time.Sleep` / `await sleep` before handler completes |
| `401`/`429`/`500` | status + matching fault fixture body |
| `invalid_json` | raw write `fixtures/invalid-json.body.txt`, `Content-Type: application/json` |
| `truncated` | write first N bytes of success body, then hard-close |
| `quota_limited` | return `flags-v2-quota-limited.json` with 200 |
| `offline` | harness stops process or uses dead port — not an in-process mode |

## SSRF / binding

- Bind **loopback only** by default (`127.0.0.1`).
- Refuse to start if `--host` is non-loopback unless `--allow-non-loopback` (CI should never set this).
- Aligns with `contracts/security/sec-endpoint-ssrf-allowlist.json` (SDK-side allowlist); stub itself must not be exposed.

## Mapping to contract faults

| Contract fixture | Stub mode |
| --- | --- |
| `fault-timeout` | `delay` + short client timeout |
| `fault-auth-401` | `401` |
| `fault-rate-limit-429` | `429` |
| `fault-quota-limited-flags` | `quota_limited` |
| `fault-network-error` / `fault-offline` | kill stub / bad port |
| `fault-malformed-json` | `invalid_json` |
| `fault-backend-500` | `500` |
| `fault-stale-cache` | definitions `500` after initial success load |

## Verification

1. Golden-file tests: each fixture body byte-identical to files in `fixtures/`.
2. Manual: `curl` scripts in future `implementation/smoke.sh`.
3. Contract CI job `adapter-http` depends on stub boot + `/health`.

## Open items for Agent D / orchestrator

- Exact local-evaluation URL path + auth header names per pinned PostHog SDK (fill `PATHS.md`).
- Whether snapshot types expose `reason`/`requestId` publicly (affects how rich `/flags` needs to be for unit vs I&T).
- ~~Ratified context limits superseding provisional bounds in contracts~~ — resolved 2026-07-27: orchestrator ratified 128 attrs / 256 B keys / 4 KiB values / depth 6 / 64 KiB serialized (see `contracts/README.md`).
