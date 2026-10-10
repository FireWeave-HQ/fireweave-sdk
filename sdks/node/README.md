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

## Quick start (one line: the start profile)

Most apps need only this ([ADR-0012](../../docs/adr/0012-start-profile.md)). Two small files and one import:

```ts
// src/fireweave/control-points.ts: every control point the app reads, with its local value
import { defineControlPoints } from '@fireweaveai/server-sdk/start';

export const controlPoints = defineControlPoints({
  'new-checkout': { local: true }, // served only in local mode
});
```

```ts
// src/fireweave/start.ts
import { start } from '@fireweaveai/server-sdk/start';
import { controlPoints } from './control-points';

start({ controlPoints });
```

```ts
// src/main.ts: must be the FIRST import
import './fireweave/start';
```

```ts
// any call site
import { fw } from '@fireweaveai/server-sdk/start';

// @fireweave-controlpoint new-checkout
if (await fw.controlPoints.getBooleanValue('new-checkout', false, { targetingKey: user.id })) { /* … */ }
await fw.identify(user.id, { plan: user.plan });                                   // at sign-in
await fw.controlPoints.getBooleanValue('nightly-reindex', false, { targetingKey: fw.instanceKey() }); // server as subject
```

Deployed environments set one variable, `FIREWEAVE_KEY` (the project key, `project-api-key_…`).
Local development needs nothing when `NODE_ENV` (or `APP_ENV` / `FIREWEAVE_ENV`) is
`development`, `dev`, `local` or `test`.

### Options and overrides

Every value resolves as: `start()` option, then env var, then legacy name (warns once), then default.

| Option | Env var | Default | What it does |
| --- | --- | --- | --- |
| `controlPoints` | — | `{}` | Local values per control point. Ignored in remote mode. |
| `mode` | — | inferred | `'remote'` or `'local'`. Overrides inference. `'remote'` without a key is a start error; `'local'` ignores a key. |
| `environment` | `FIREWEAVE_ENV`, `APP_ENV`, `NODE_ENV` | — | Environment name used for inference when there is no key and no `mode`. Pass your own, e.g. `environment: process.env.DEPLOY_STAGE`. |
| `url` | `FIREWEAVE_URL` (legacy `FW_API_URL`, `FW_ATTEST_URL`) | from the SDK build | A `-rc.N` build (`@next`) calls `staging-app-server.fireweave.ai`; any other calls `app-server.fireweave.ai`. Set it for a self-hosted or local fw-server. |
| `key` | `FIREWEAVE_KEY` (legacy `FW_PROJECT_API_KEY`) | — | Project key. Pass it to read from your own secret store. Browser keys and vendor keys are rejected at start. |
| `instanceId` | `FIREWEAVE_INSTANCE_ID` | hash of the host name | Value of `fw.instanceKey()`. Nothing is written to disk. |
| `env` | — | the process | Read values from this object instead of the environment. |
| `log` | — | console | Where `[fireweave]` lines go. |

**Mode rule.** `mode` wins. Otherwise: a key means remote. No key and a development
environment name means local. Anything else (including no environment name at all) throws
at `start()`, naming the variable, so a deploy that forgot its key fails instead of silently
serving defaults.

**Reads never throw.** If start fails, reads return your default (`*Details` return an `ERROR`
decision). `fw.status()` reports the mode, channel, host and key source, never the key.
`start()` is idempotent; a second call with a different config throws. Zero-config apps can use
`import '@fireweaveai/server-sdk/register'` (or `node --import`, `bun --preload`) instead of
`src/fireweave/start.ts`.

**When reads return only defaults.** A revoked or wrong key must not look like a rollout at 0%.
When fw-server refuses the key (HTTP 401 or 403), rate-limits it (429) or cannot be reached
(network error, timeout, 5xx), the start profile logs **one** `[fireweave]` line per kind for the
life of the process, naming where the key came from (`FIREWEAVE_KEY`, `FW_PROJECT_API_KEY` or
`start({ key })`) or the endpoint host, never the key itself. `fw.status().lastErrorKind` holds
the kind of the latest failed request (`Authentication`, `Authorization`, `RateLimited`,
`Network`, `Timeout` or `BackendUnavailable`). It is sticky: once requests succeed again, reads
return real values, but `lastErrorKind` keeps the last failure and the line is not logged again.
A fresh `start()` after `fw.shutdown()` clears it.

## Quick start (production path, core API)

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

The key is `controlPointKey` everywhere, on the wire and in `Decision`, from 3.0.0
([ADR-0013](../../docs/adr/0013-control-point-wire.md)).

## Module layout

| Module | Responsibility |
| --- | --- |
| `application/runtime.ts` | Lifecycle state machine, config validation, context policy, decision construction. Evaluation never throws. |
| `application/client.ts` | `FireweaveClient` — `controlPoints`, `registerTarget`. |
| `application/mode.ts` | `initFireweave` — the single entry point; the only module allowed to import concrete adapters. |
| `infrastructure/adapters/remote.ts` | `FireweaveRemoteAdapter` — the production backend (`/v1/control-points/evaluate`, `/v1/targets/register`). |
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

## Upgrading from 2.x: `flags` → `controlPoints`

`client.flags` was removed in 3.0.0 ([ADR-0013](../../docs/adr/0013-control-point-wire.md)); use `client.controlPoints`, which is the same object it returned. `Decision.flagKey` is now `Decision.controlPointKey`, the error kind `FlagNotFound` is `ControlPointNotFound`, and the start option `flags` is `controlPoints` (`defineControlPoints`). Scope the edit. `flags` is an ordinary word: your repo very likely contains feature-flag code, config keys, DB columns, and `flags` variables that have nothing to do with this SDK.

**Rename only `.flags` accesses whose receiver is provably a `FireweaveClient`** — traceable to a `new FireweaveClient(...)`/`initFireweave(...)` call, an imported binding assigned from one, or a parameter annotated `FireweaveClient`.

Never rename:

| Looks similar | Why it stays |
| --- | --- |
| `new InMemoryAdapter({ flags: … })` | SDK option key, unchanged |
| `FlagValueType`, `InMemoryFlagDefinition` | SDK API, unchanged |
| your own `flags` variables, `featureFlags`, CLI `--flags`, `flags` columns | not this SDK |
| another vendor's SDK (`ldClient.variation`, flagd, Unleash) | not this SDK |

**Do not run a repo-wide `flags` → `controlPoints` replacement** — not with `sed`, not with editor replace-all. Go call site by call site, and when a receiver is ambiguous, leave it. The compiler finds a missed rename; a wrong one breaks unrelated code.

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
