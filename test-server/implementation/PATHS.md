# Observed SDK paths (fill at pin time)

## Fireweave remote protocol (ADR-0005 — default production path)

Served by this stub and by fw-server:

| Method | Path | Auth |
| --- | --- | --- |
| `POST` | `/v1/flags/evaluate` | `Authorization: Bearer <project-api-key_…>` (or `x-api-key`) |
| `POST` | `/v1/capture` | same |

Schemas: `spec/remote-evaluate.schema.json`, `spec/remote-capture.schema.json`, `spec/remote-protocol.md`.
The stub maps internal PostHog fixtures → Fireweave decision/capture envelopes (no PostHog field names on the wire).

---

## PostHog protocol candidates (advanced / PostHogAdapter)

Record the exact HTTP paths and auth schemes used by pinned PostHog SDKs when pointed at this stub. Until filled, harnesses should try the candidates below in order.

### Remote flags

- `POST /flags?v=2`
- `POST /flags/?v=2`
- Body fields: `api_key` / `token` (`phc_…`), `distinct_id`, `person_properties`, `groups`, `group_properties`, `flag_keys` / equivalent

### Local evaluation definitions

- `GET /api/feature_flag/local_evaluation/?token=<phc>&send_cohorts=true` (**candidate**)
- Auth: `Authorization: Bearer <phs_or_phx>` (**candidate**)
- Confirm against `posthog-node@5.46.1`, `posthog==7.31.0`, `posthog-go@v1.22.0`, `posthog-server:2.9.0`

### Capture batch

- `POST /batch/`
- `POST /batch`
- Body: `{api_key, batch: [...]}` (**candidate**)

## Pin verification log

| SDK | Version | Flags path | Definitions path | Batch path | Verified |
| --- | --- | --- | --- | --- | --- |
| posthog-node | 5.46.1 | TBD | TBD | TBD | no |
| posthog | 7.31.0 | TBD | TBD | TBD | no |
| posthog-go | v1.22.0 | TBD | TBD | TBD | no |
| posthog-server | 2.9.0 | TBD | TBD | TBD | no |
