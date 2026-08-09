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
| `POST` | `/v1/targets/register` | [`remote-register-target.schema.json`](./remote-register-target.schema.json) | Register a user or device for targeting (optional; Node SDK only today) |

Optional later: `GET /v1/flags/definitions` for local-eval parity.

## Two identity paths

A target's properties reach an evaluation by two different routes, and they compose:

| | Registered target | Evaluation context |
| --- | --- | --- |
| Written by | `POST /v1/targets/register` | `attributes` on `POST /v1/flags/evaluate` |
| Set | once, at login / provisioning | on every evaluate call |
| Lifetime | stored server-side | that one request |
| Use for | durable facts: plan, beta, region, device model | per-request state: page, session, experiment context |

**Resolution:** attributes supplied on an evaluate call win for that evaluation;
stored target properties fill in everything not sent. There is no merge step in
the SDK — the backing provider resolves them in that order natively.

Consequence worth stating plainly: a rule that targets a property the app never
registers AND never sends matches nobody, silently. Register the durable facts;
send only what genuinely varies per request.

`targetingKey` is the join between the two — register a target with an id, then
send that same id on evaluate and capture. fw-server scopes ids per project, so
two projects using the same raw id are different targets.

## Browser clients (ADR-0009)

`@fireweaveai/web-sdk` speaks this same protocol from a browser. Three things differ, and each is a server-side obligation rather than an SDK one.

**Any origin.** Browser callers arrive from origins fw-server cannot enumerate, so `/v1/flags/evaluate`, `/v1/capture`, and `/v1/targets/register` accept **any** `Origin`. The preflight must allow the `authorization` and `content-type` request headers, and should set a `Max-Age` so a preflight is not paid on every evaluate. This is not a relaxed boundary: these routes authenticate by bearer token and ignore cookies, so origin never protected them.

**The key is the whole boundary.** A browser key is public by construction — anything in a bundle is readable. It must therefore be scoped to `flags:evaluate` + `events:write` and rate-limited per key. Do **not** issue a browser a key carrying `attest:write` or any deploy-time scope. fw-server implements this as a distinct `fw_public_…` key family carrying exactly those scopes; its attest plane rejects that family outright, and the runtime-proxy routes answer `429` with a `Retry-After` header when a key exceeds its per-key limit. Where the app has a same-origin backend, injecting the key server-side (a BFF) remains the better pattern and avoids the question entirely.

**Batch, then read.** A browser evaluates synchronously against a prefetched cache, so it calls `/v1/flags/evaluate` **once per context** with no `flagKeys` filter (or a known subset) and reads every decision from the response. Servers should expect one batch call per page load and per identity change, not one call per control point.

Capture from a browser may arrive via `navigator.sendBeacon` or `fetch(..., { keepalive: true })` during page unload. Both send `POST` with the JSON body unchanged; `sendBeacon` cannot set an `Authorization` header, so a browser using it must carry the key another way the server accepts (`x-api-key` is already accepted above, but not settable on a beacon either — a keepalive `fetch` is the portable choice when a header is required). Unload-time delivery is best-effort by definition: neither transport reports failure to the page.

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

## Register target (sketch)

```json
{
  "targetingKey": "user-123",
  "kind": "user",
  "environment": "production",
  "properties": { "plan": "enterprise", "beta": true }
}
```

Response: `{ "ok": true, "targetingKey": "user-123" }`.

`fw_`-prefixed property keys are reserved for server-authoritative tenancy
stamps and are stripped — a client cannot claim another tenant's identity.
Registration is idempotent: re-registering the same `targetingKey` updates the
stored properties.
