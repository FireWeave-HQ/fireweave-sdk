# @fireweaveai/server-sdk (Node SDK)

Fireweave release-engineering SDK for server runtimes — **control points** and **target
registration**, the two v1 capabilities ([spec/control-points.md](../../spec/control-points.md)
"Scope of v1"; spec v0.1.0).

- **Zero runtime dependencies.**
- **Runs on Node ≥ 20.20, Bun ≥ 1.2, and Deno ≥ 2.0** — no Node built-ins, no Node globals ([ADR-0008](../../docs/adr/0008-multi-runtime-support.md)).
- **No vendor SDK, key, or hostname in your process.** Applications hold a Fireweave project key and talk to fw-server; which backend fw-server forwards to is fw-server's concern ([ADR-0005](../../docs/adr/0005-fireweave-proxy-backend.md), [ADR-0006](../../docs/adr/0006-node-drops-direct-posthog-adapter.md)).

## Install

```bash
npm install @fireweaveai/server-sdk   # or: bun add …
```

```ts
// Deno needs no install step
import { initFireweave } from 'npm:@fireweaveai/server-sdk';
```

## Quick start (production path)

```ts
import { initFireweave } from '@fireweaveai/server-sdk';

// apiUrl/apiKey are required, explicit options — the SDK reads no
// environment variables (spec/modes.md).
const fireweave = await initFireweave({
  mode: 'remote',
  apiUrl: process.env.FW_API_URL!,
  apiKey: process.env.FW_PROJECT_API_KEY!,
});

// Once per login: the durable facts your targeting rules match on.
await fireweave.registerTarget('user_42', {
  kind: 'user',
  properties: { plan: 'pro', region: 'eu-west' },
});

// Per request.
const enabled = await fireweave.controlPoints.getBooleanValue('new-checkout', false, {
  targetingKey: 'user_42',
});

await fireweave.shutdown();   // flushes queued network I/O first
```

## Quick start (offline, local mode)

```ts
import { initFireweave } from '@fireweaveai/server-sdk';

const fireweave = await initFireweave({
  mode: 'local',
  local: { controlPoints: { 'new-checkout': true } },
});

// → true
await fireweave.controlPoints.getBooleanValue('new-checkout', false, { targetingKey: 'u1' });

await fireweave.shutdown();
```

`initFireweave` is the single entry point (`spec/modes.md`): `mode` is required and never
inferred, so a missing or mistyped credential fails loudly at boot instead of silently falling
back to local evaluation. Reads on the returned client never throw — every failure resolves to
the caller's `default` with a `Decision` naming the reason (`spec/control-points.md` "Return
discipline").

## Lower-level construction

`initFireweave` is a thin composition root over exported pieces — construct them directly for a
custom adapter or advanced wiring:

```ts
import { FireweaveClient, FireweaveRemoteAdapter, FireweaveRuntime } from '@fireweaveai/server-sdk';

const runtime = new FireweaveRuntime(new FireweaveRemoteAdapter({ apiUrl, apiKey }));
const fireweave = new FireweaveClient(runtime);
await fireweave.initialize();
```

The per-call parameter is `flagKey`, not `controlPointKey` — that name is fixed by
`spec/decision.schema.json` and the wire protocol shared with the Python, Go, and Java SDKs.
"Control point" is the product noun; `flagKey` is its key at those boundaries
([ADR-0007](../../docs/adr/0007-control-point-vocabulary.md)).

## Module layout

| Module | Responsibility |
| --- | --- |
| `application/runtime.ts` | Lifecycle state machine, config validation, context policy, decision construction. Evaluation never throws. |
| `application/client.ts` | `FireweaveClient` — `controlPoints`, `registerTarget`. |
| `application/mode.ts` | `initFireweave` — the single entry point; the only module allowed to import concrete adapters. |
| `infrastructure/adapters/remote.ts` | `FireweaveRemoteAdapter` — the production backend (`/v1/flags/evaluate`, `/v1/targets/register`). |
| `infrastructure/adapters/inmemory.ts` | Deterministic fixture-driven adapter for tests and conformance. |
| `infrastructure/adapters/local.ts` | `FireweaveLocalAdapter` — the DEV substrate `initFireweave({ mode: 'local' })` builds. |
| `application/ports.ts` | The `BackendAdapter` boundary. |
| `domain/context.ts` | Merge order (global → client → invocation), deep copy, bounds, reserved keys. |
| `domain/errors.ts` | The 15-kind error taxonomy and secret redaction. |
| `infrastructure/hosts.ts` | SSRF allowlist (on by default; https required off-loopback). |

## Configuration

The SDK reads no environment variables (spec/modes.md) — every option is an explicit argument to
`initFireweave` (or the adapter constructor, for lower-level use).

| Option | Mode | Description |
| --- | --- | --- |
| `apiUrl` | `remote` | fw-server base URL (required) |
| `apiKey` | `remote` | Fireweave project key (`project-api-key_…`) (required) |
| `allowedHosts` | `remote` | SSRF allowlist override |
| `local.controlPoints` | `local` | seeded boolean overrides; a present key resolves `STATIC`, an absent key misses to the caller's default with reason `DEFAULT` |

## Renaming `flags` → `controlPoints` safely

`client.flags` is a deprecated alias of `client.controlPoints` — identical, permanent, and not scheduled for removal, so renaming is optional. To adopt the new name, scope the edit. `flags` is an ordinary word: your repo very likely contains feature-flag code, config keys, DB columns, and `flags` variables that have nothing to do with this SDK.

**Rename only `.flags` accesses whose receiver is provably a `FireweaveClient`** — traceable to a `new FireweaveClient(...)`/`initFireweave(...)` call, an imported binding assigned from one, or a parameter annotated `FireweaveClient`.

Never rename:

| Looks similar | Why it stays |
| --- | --- |
| `new InMemoryAdapter({ flags: … })` | SDK option key, unchanged |
| `flagKey`, `FlagValueType`, `InMemoryFlagDefinition` | SDK API, unchanged |
| your own `flags` variables, `featureFlags`, CLI `--flags`, `flags` columns | not this SDK |
| another vendor's SDK (`ldClient.variation`, flagd, Unleash) | not this SDK |

**Do not run a repo-wide `flags` → `controlPoints` replacement** — not with `sed`, not with editor replace-all. Go call site by call site, and when a receiver is ambiguous, leave it. A missed cosmetic rename costs nothing; a wrong one breaks unrelated code.

## Development

```bash
npm install          # from sdks/node
npm run build        # emit dist/ (package exports resolve to it)
npm run verify       # typecheck + unit + integration + conformance + smoke
npm run smoke        # cross-runtime smoke (Node leg)

bun test test/unit test/integration
bun  scripts/smoke-runtimes.mjs
deno run --allow-read scripts/smoke-runtimes.mjs
```

## Documentation

Full docs live in [`docs/`](../../docs/): [remote adapter](../../docs/remote.md) · [runtimes](../../docs/runtimes.md) · [testing](../../docs/testing.md) · [troubleshooting](../../docs/troubleshooting.md) · [ADRs](../../docs/adr/).

## License

[MIT](../../LICENSE).
