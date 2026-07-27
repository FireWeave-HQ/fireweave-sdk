# Observed SDK paths (fill at pin time)

Record the exact HTTP paths and auth schemes used by pinned PostHog SDKs when pointed at this stub. Until filled, harnesses should try the candidates below in order.

## Candidates

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
