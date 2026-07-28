# Fireweave remote adapter (production default)

Per [ADR-0005](adr/0005-fireweave-proxy-backend.md), applications authenticate with a
**Fireweave** project key and call **fw-server**. PostHog credentials never enter the app process.

## Config

| Option | Env | Description |
| --- | --- | --- |
| `apiUrl` / `host` | `FW_API_URL` | fw-server base URL |
| `apiKey` / `projectApiKey` | `FW_PROJECT_API_KEY` | `project-api-key_…` (attest/runtime key family) |

Wire protocol: [spec/remote-protocol.md](../spec/remote-protocol.md).

| Method | Path |
| --- | --- |
| `POST` | `/v1/flags/evaluate` |
| `POST` | `/v1/capture` |

Auth: `Authorization: Bearer <FW_PROJECT_API_KEY>`.

## Local stub

```bash
node test-server/implementation/server.mjs
# listens on http://127.0.0.1:3901
# serves /v1/flags/evaluate + /v1/capture (and legacy PostHog paths)
```

```bash
cd examples/node
FW_API_URL=http://127.0.0.1:3901 FW_PROJECT_API_KEY=project-api-key_dev \
  node index.mjs --remote
```

## Adapters by language

| Language | Class | Notes |
| --- | --- | --- |
| Node | `FireweaveRemoteAdapter` from `@fireweaveai/sdk` | Default production path; no `posthog-node` |
| Python | `FireweaveRemoteAdapter` from `fireweave` | stdlib `urllib` |
| Go | `adapters/remote` | `net/http` |
| Java | `ai.fireweave.sdk.FireweaveRemoteAdapter` | JDK `HttpClient`; no PostHog server SDK |

## Advanced: direct PostHog

See [posthog.md](posthog.md). Not the quickstart path.
