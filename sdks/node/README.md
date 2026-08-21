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
| `allowedHosts` | `remote` | SSRF allowlist override; defaults to the `apiUrl` host plus loopback |
| `local.controlPoints` | `local` | seeded boolean overrides; a present key resolves `STATIC`, an absent key misses to the caller's default with reason `DEFAULT` |

## Upgrading from v2.0 to 2.1

**Only one change is mandatory.** If you imported the direct vendor adapter, swap it. Everything else from v2 still works, so most of this section exists to tell you what you *don't* have to do.

### Does this affect me?

```bash
# Mandatory to fix (any hit ⇒ migration required)
rg -n "@fireweaveai/server-sdk/posthog|PostHogAdapter"
rg -n '"posthog-node"' package.json

# Configuration that moves
rg -n "POSTHOG_HOST|POSTHOG_API_KEY|POSTHOG_PROJECT_API_KEY"
```

No hits? Bump the version; you are done.

### 1. Swap the adapter (required)

```ts
// before
import { PostHogAdapter } from '@fireweaveai/server-sdk/posthog';
const adapter = new PostHogAdapter({
  projectApiKey: process.env.POSTHOG_API_KEY,
  host: process.env.POSTHOG_HOST,
  featureFlagsRequestTimeoutMs: 3000,
});

// after
import { initFireweave } from '@fireweaveai/server-sdk';
const fireweave = await initFireweave({
  mode: 'remote',
  apiUrl: process.env.FW_API_URL!,
  apiKey: process.env.FW_PROJECT_API_KEY!,
});
```

| v2 option | 2.1 |
| --- | --- |
| `projectApiKey` (`phc_…`) | `apiKey` (`project-api-key_…`) |
| `host` | `apiUrl` |
| `featureFlagsRequestTimeoutMs` | `requestTimeoutMs` (adapter-level; `initFireweave` does not expose it directly — use *Lower-level construction* above if you need it) |
| `shutdownTimeoutMs`, `allowedHosts` | unchanged |
| `secretApiKey`, `onlyEvaluateLocally`, `featureFlagsPollingInterval`, `waitForLocalDefinitions`, `client` | **no equivalent** — see §4 |

Then:

- Remove `posthog-node` from `package.json` — **unless** you use it for your own analytics capture. Check with `rg "posthog-node"` first.
- Update deployment config, secret stores, and CI: `POSTHOG_HOST` → `FW_API_URL`, `POSTHOG_API_KEY` → `FW_PROJECT_API_KEY`. **The new key is a Fireweave project key, not a re-labelled vendor key** — it has to be issued from your Fireweave project.

### 2. What you do *not* have to change

| v2 | Status in 2.1 |
| --- | --- |
| `client.flags.evaluate` / `getBooleanValue` / … | works — the same object as `client.controlPoints` |
| `new InMemoryAdapter({ flags })` | unchanged |
| `Decision.flagKey`, `flagMetadata` | unchanged |
| `FlagValueType`, `InMemoryFlagDefinition`, `ExpectedFlagType` | unchanged |
| every other v2 export | unchanged |

`client.flags === client.controlPoints` — a getter returning the same instance, not a copy. It is
marked `@deprecated` in JSDoc and **is not scheduled for removal in the 2.x line**; retiring it
would need its own major and its own ADR. Renaming your call sites is cosmetic and can be
deferred indefinitely. Accessing `client.flags` is silent at runtime — no log line, no env gate —
because the SDK reads no environment variables regardless (spec/modes.md); the deprecation is
conveyed by JSDoc only.

### 3. Two type-level narrowings

`'posthog'` is no longer a member of `BackendAdapter['name']` or `Capabilities['runtime']['backend']`.

- A custom adapter declaring `name: 'posthog'` → use `'other'`.
- An exhaustive `switch` on `backend` with a `case 'posthog'` → that arm is unreachable; remove it.

Both are rare, and `tsc` points straight at them.

### 4. Local evaluation is gone

v2's vendor adapter could evaluate in-process from polled definitions with a secret key. 2.1 has no equivalent: caching is fw-server's concern, and both shipped adapters report `localEvaluation: false`.

If in-process evaluation is load-bearing for you — an air-gapped service, or a latency floor below one network hop — **stay on v2 for now and tell us**. The interface seam (`AdapterRuntimeFeatures.localEvaluation` / `localOnly`, `AdapterResolution.fromCache`, the `STALE` reason) is deliberately preserved for a future Fireweave-native cache ([ADR-0006](../../docs/adr/0006-node-drops-direct-posthog-adapter.md)).

### 5. Worth re-checking

1. **`DEFAULT_ALLOWED_HOSTS` changed contents** while keeping its name. It now lists Fireweave hosts, not vendor hosts. Code doing `allowedHosts: [...DEFAULT_ALLOWED_HOSTS, 'mine.example']` keeps compiling and silently stops permitting the old endpoints. That is intended — verify it matches your deployment.
2. **Move durable attributes to `registerTarget`.** Attributes you resend on every evaluation can be registered once per login. Per-request attributes still override stored properties, so the two compose — this is an optimization, not a cutover. Note that `registerTarget` returns `{ ok }` rather than throwing (it sits in sign-in paths); log `ok: false`, because a silently unregistered target is exactly how targeting rules end up matching nobody.

### 6. Verify

```bash
npm install @fireweaveai/server-sdk@latest
npx tsc --noEmit                                  # catches §3
<your test command>
rg -n "@fireweaveai/server-sdk/posthog|PostHogAdapter"   # expect no hits
```

At runtime, a boolean read against a known-on control point should resolve `true` with reason
`TARGETING_MATCH`/`SPLIT`/`STATIC` (never `ERROR`); if it resolves the default with reason
`ERROR`, the remote adapter was never wired in correctly — check `apiUrl`/`apiKey`.

### Rollback

```bash
npm install @fireweaveai/server-sdk@2   # re-add posthog-node if you removed it
```

Revert the adapter swap and the env vars. No data migration is involved, so rollback is code and config only.

---

## Renaming `flags` → `controlPoints` safely

If you do decide to adopt the new name, scope the edit. `flags` is an ordinary word: your repo very likely contains feature-flag code, config keys, DB columns, and `flags` variables that have nothing to do with this SDK.

**Rename only `.flags` accesses whose receiver is provably a `FireweaveClient`** — traceable to a `new FireweaveClient(...)`/`initFireweave(...)` call, an imported binding assigned from one, or a parameter annotated `FireweaveClient`.

Never rename:

| Looks similar | Why it stays |
| --- | --- |
| `new InMemoryAdapter({ flags: … })` | SDK option key, unchanged |
| `flagKey`, `flagMetadata`, `FlagValueType`, `InMemoryFlagDefinition` | SDK API, unchanged |
| `features.flags` in the capability matrix | still `true`; removing it fails conformance |
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

Full docs live in [`docs/`](../../docs/): [quickstart](../../docs/quickstart.md) · [remote adapter](../../docs/remote.md) · [runtimes](../../docs/runtimes.md) · [testing](../../docs/testing.md) · [migration](../../docs/migration.md) · [troubleshooting](../../docs/troubleshooting.md) · [ADRs](../../docs/adr/).

## License

[MIT](../../LICENSE).
