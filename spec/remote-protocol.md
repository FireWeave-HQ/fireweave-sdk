# Fireweave remote protocol (ADR-0005)

Vendor-neutral HTTP API spoken by SDKs (`FireweaveRemoteAdapter`) to **fw-server**.
PostHog (or another provider) is an fw-server implementation detail — never appear in this wire format.

## Auth

```
Authorization: Bearer <Fireweave project/runtime key>
```

Also accepted: `x-api-key: <key>`.

**Current key:** `project-api-key_…` (`FW_PROJECT_API_KEY`), same family as deploy-beacon attest.
MVP fw-server verifies with existing attest permissions (`attest:write`). Expanded scopes
(`flags:evaluate`, `events:write`) or a dedicated `fw_runtime_…` prefix are TBD on the platform.

Never send PostHog `phc_` / `phs_` / `phx_` keys on this path.

## Endpoints

| Method | Path | Schema | Purpose |
| --- | --- | --- | --- |
| `POST` | `/v1/flags/evaluate` | [`remote-evaluate.schema.json`](./remote-evaluate.schema.json) | Batch flag evaluation (side-effect-free) |
| `POST` | `/v1/capture` | [`remote-capture.schema.json`](./remote-capture.schema.json) | Exposures / signals / events batch |

Optional later: `GET /v1/flags/definitions` for local-eval parity.

## Config (SDK)

| Option | Env | Description |
| --- | --- | --- |
| `apiUrl` | `FW_API_URL` | fw-server base URL (no trailing slash required) |
| `apiKey` | `FW_PROJECT_API_KEY` | Fireweave project/runtime key |

## Evaluate (sketch)

Request:

```json
{
  "targetingKey": "user-123",
  "attributes": { "email": "a@example.com" },
  "groups": { "company": "acme" },
  "groupProperties": { "company": { "plan": "pro" } },
  "flagKeys": ["checkout-v2"]
}
```

Response decisions are compatible with [`decision.schema.json`](./decision.schema.json)
(`flagKey`, `value`, `reason`) plus `found` / `enabled` for adapter resolution.

## Capture (sketch)

```json
{
  "events": [
    {
      "type": "exposure",
      "targetingKey": "user-123",
      "flagKey": "checkout-v2",
      "value": "treatment-b",
      "variant": "treatment-b"
    }
  ]
}
```

fw-server maps `type=exposure` to the connected provider’s exposure event
(today: PostHog `$feature_flag_called`). SDKs never emit that name on the public wire.
