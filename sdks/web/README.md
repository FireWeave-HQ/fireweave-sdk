# @fireweaveai/web-sdk (Web SDK)

Fireweave control points for the browser ([ADR-0009](../../docs/adr/0009-browser-control-points.md)) —
**control points** and **target registration**, the two v1 capabilities
([spec/control-points.md](../../spec/control-points.md) "Scope of v1"; spec v0.1.0).

- **Remote-only and secret-free by construction.** No local evaluation, no vendor SDK dependency, no environment reads, and vendor/secret key shapes are rejected at the door.
- **Reads are synchronous** — `controlPoints.getBooleanValue(...)` returns a value directly, no `await`, safe inside a render path. `initFireweave` prefetches a decision cache once per context; reads afterward are a pure in-memory lookup.
- **Bun is the toolchain.** Tested on Bun only — this package ships no server entry point, reads no environment, and imports no runtime built-ins, so Node/Deno are not target runtimes for it.

## Install

```bash
bun add @fireweaveai/web-sdk   # or: npm install @fireweaveai/web-sdk
```

## Quick start (production path)

```ts
import { initFireweave } from '@fireweaveai/web-sdk';

// apiKey/apiUrl are required, explicit options — the SDK reads no
// environment variables (spec/modes.md). The apiKey is a Fireweave PROJECT
// key, public by construction (ADR-0009) — never a secret.
const fireweave = await initFireweave({
  mode: 'remote',
  apiKey: PUBLIC_FW_PROJECT_API_KEY,
  apiUrl: PUBLIC_FW_API_URL,
  context: { targetingKey: 'anonymous' },
});

// Reads are SYNCHRONOUS — no await, safe inside render.
const enabled = fireweave.controlPoints.getBooleanValue('new-checkout', false);

// At sign-in: register durable targeting facts, then re-prefetch under that id.
await fireweave.identify('user_42', { kind: 'user', properties: { plan: 'pro' } });

await fireweave.shutdown();
```

## Quick start (offline, local mode)

```ts
import { initFireweave } from '@fireweaveai/web-sdk';

const fireweave = await initFireweave({
  mode: 'local',
  local: { controlPoints: { 'new-checkout': true } },
});

// → true
fireweave.controlPoints.getBooleanValue('new-checkout', false);

await fireweave.shutdown();
```

`initFireweave` is the single entry point (spec/modes.md): `mode` is required and never inferred.
A bad host or missing credential still fails loudly at `initFireweave()` even though
`FireweaveWebRuntime.initialize()` itself is deliberately fail-open — a hung or failing prefetch
must not block app boot ([ADR-0009](../../docs/adr/0009-browser-control-points.md) "Fail-open, not
fail-silent"). When the initial prefetch race loses to its ceiling, the runtime serves defaults
with reason `STALE` rather than blocking.

## Module layout

| Module | Responsibility |
| --- | --- |
| `application/runtime.ts` | `FireweaveWebRuntime` — prefetch-once-per-context cache, lifecycle state, sync reads. |
| `application/client.ts` | `FireweaveWebClient` — `controlPoints`, `registerTarget`, `identify`. |
| `application/mode.ts` | `initFireweave` — the single entry point; the only module allowed to import concrete adapters. |
| `infrastructure/adapters/remote.ts` | `FireweaveRemoteWebAdapter` — the production backend (`/v1/flags/evaluate`, `/v1/targets/register`). |
| `infrastructure/adapters/inmemory.ts` | Deterministic fixture-driven adapter for tests and conformance. |
| `infrastructure/adapters/local.ts` | `FireweaveLocalWebAdapter` — the DEV substrate `initFireweave({ mode: 'local' })` builds. |
| `application/ports.ts` | The `WebBackendAdapter` boundary. |
| `domain/context.ts` | Merge order, deep copy, bounds, reserved keys. |
| `domain/errors.ts` | The 15-kind error taxonomy. |
| `infrastructure/hosts.ts` | SSRF allowlist + secret-key-shape rejection (on by default; https required off-loopback). |

## Configuration

The SDK reads no environment variables — every option is an explicit argument to `initFireweave`.

| Option | Mode | Description |
| --- | --- | --- |
| `apiUrl` | `remote` | fw-server base URL (required) |
| `apiKey` | `remote` | Fireweave **project** key — public by construction, never a secret (required) |
| `allowedHosts` | `remote` | SSRF allowlist override; defaults to the `apiUrl` host plus loopback |
| `context` | both | initial evaluation context (e.g. an anonymous `targetingKey`) to prefetch under |
| `local.controlPoints` | `local` | seeded boolean overrides; a present key resolves `STATIC`, an absent key misses to the caller's default with reason `DEFAULT` |

## Development

```bash
bun install          # from sdks/web
bun run build        # emit dist/ (package exports resolve to it)
bun run verify        # typecheck + test + conformance
```

## Documentation

Full docs live in [`docs/`](../../docs/), and [ADR-0009](../../docs/adr/0009-browser-control-points.md) records the browser-specific design (fail-open prefetch, secret-key rejection, sync reads).

## License

[MIT](../../LICENSE).
