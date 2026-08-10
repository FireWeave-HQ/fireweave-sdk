# The Fireweave backend adapter

`FireweaveRemoteAdapter` is the production path ([ADR-0005](adr/0005-fireweave-proxy-backend.md)). Applications authenticate with a **Fireweave project key** and call **fw-server**. Which backend fw-server forwards to is fw-server's concern — no third-party SDK, key, or hostname enters the application process.

On Node this is the only network adapter; the direct vendor adapter was removed in v3 ([ADR-0006](adr/0006-node-drops-direct-posthog-adapter.md)).

## Config

| Option | Env | Description |
| --- | --- | --- |
| `apiUrl` | `FW_API_URL` | fw-server base URL |
| `apiKey` | `FW_PROJECT_API_KEY` | `project-api-key_…` (attest/runtime key family) |
| `requestTimeoutMs` | — | per-request deadline (default 3000) |
| `shutdownTimeoutMs` | — | flush deadline during shutdown (default 10 000) |
| `allowedHosts` | — | SSRF allowlist override; defaults to the `apiUrl` hostname plus loopback |

```ts
const adapter = new FireweaveRemoteAdapter({
  apiUrl: 'https://app-server.fireweave.ai',
  apiKey: process.env.FW_PROJECT_API_KEY,
  requestTimeoutMs: 3000,
});
```

Omit `apiUrl`/`apiKey` to read them from the environment. On Deno that lookup needs `--allow-env`; without the permission the adapter reports the variables as absent rather than throwing, so passing both explicitly requires no env permission at all ([docs/runtimes.md](runtimes.md)).

`https` is required for non-loopback hosts. Plain `http` is permitted on loopback only, for the local stub.

## Wire protocol

Full contract: [spec/remote-protocol.md](../spec/remote-protocol.md). Auth is `Authorization: Bearer <FW_PROJECT_API_KEY>` on every call.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/flags/evaluate` | evaluate control points for one targeting key |
| `POST` | `/v1/capture` | batched exposures / signals / events |
| `POST` | `/v1/targets/register` | durable targeting properties for a user or device |

### Two identity paths

`registerTarget` and per-request context attributes compose rather than compete:

- **`registerTarget(targetingKey, { properties })`** — call once per login or device provisioning with the facts that outlive a request: plan, beta membership, region, device model. fw-server stores them, and targeting rules match against them on every later evaluation.
- **Per-request `attributes`** — override the stored properties for a single evaluation.

`registerTarget` never throws. It sits in sign-in paths, and an analytics call must not break a login, so it resolves `{ ok: false, error }` instead. Retried once when the error taxonomy marks the failure retryable; a rejected payload or bad key is not retried, since it would be rejected identically. Log `ok: false` — a silently unregistered target is how targeting rules end up matching nobody.

Adapters without the capability (`InMemoryAdapter`) report `UnsupportedCapability`, so a dev harness never looks registered when it is not.

## Error mapping

| Response | Error kind | OpenFeature code |
| --- | --- | --- |
| 401 | `Authentication` | `GENERAL` |
| 403 | `Authorization` | `GENERAL` |
| 429 | `RateLimited` | `GENERAL` |
| 5xx | `BackendUnavailable` | `GENERAL` |
| unparseable body | `MalformedResponse` | `PARSE_ERROR` |
| transport failure | `Network` | `GENERAL` |
| deadline exceeded | `Timeout` | `GENERAL` |
| `quotaLimited: true`, control point absent | `FlagNotFound` + `fireweave.quotaLimited` | `FLAG_NOT_FOUND` |

Evaluation never throws — every one of these surfaces as an `ERROR` decision carrying your default value. Full taxonomy: [contracts/errors.md](../contracts/errors.md).

## Local stub

```bash
node test-server/implementation/server.mjs
# listens on http://127.0.0.1:3901
# serves /v1/flags/evaluate, /v1/capture, /v1/targets/register
```

```bash
cd examples/node
FW_API_URL=http://127.0.0.1:3901 FW_PROJECT_API_KEY=project-api-key_dev \
  node index.mjs --remote
```

The stub also serves legacy vendor routes, used by the Python, Go, and Java conformance harnesses. Node's fault-conformance suite drives the `/v1` routes.

## Adapters by language

| Language | Class | Notes |
| --- | --- | --- |
| Node | `FireweaveRemoteAdapter` from `@fireweaveai/sdk` | only network adapter; `fetch` |
| Python | `FireweaveRemoteAdapter` from `fireweave` | stdlib `urllib` |
| Go | `adapters/remote` | `net/http` |
| Java | `ai.fireweave.sdk.FireweaveRemoteAdapter` | JDK `HttpClient` |
