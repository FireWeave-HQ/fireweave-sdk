# @fireweaveai/server-sdk (Node SDK)

Fireweave release-engineering SDK for server runtimes — **control points**, target registration, release lifecycle, exposures, and health/outcome signals, with an OpenFeature provider for standards-compatible evaluation (spec v0.1.0).

- **Zero runtime dependencies.** One peer: `@openfeature/server-sdk` (needed only if you use the OpenFeature provider).
- **Runs on Node ≥ 20.20, Bun ≥ 1.2, and Deno ≥ 2.0** — no Node built-ins, no Node globals ([ADR-0008](../../docs/adr/0008-multi-runtime-support.md)).
- **No vendor SDK, key, or hostname in your process.** Applications hold a Fireweave project key and talk to fw-server; which backend fw-server forwards to is fw-server's concern ([ADR-0005](../../docs/adr/0005-fireweave-proxy-backend.md), [ADR-0006](../../docs/adr/0006-node-drops-direct-posthog-adapter.md)).

## Install

```bash
npm install @fireweaveai/server-sdk @openfeature/server-sdk   # or: bun add …
```

```ts
// Deno needs no install step
import { FireweaveClient, FireweaveRemoteAdapter, FireweaveRuntime } from 'npm:@fireweaveai/server-sdk';
```

## Quick start (production path)

```ts
import { FireweaveClient, FireweaveRemoteAdapter, FireweaveRuntime } from '@fireweaveai/server-sdk';

// apiUrl/apiKey are required, explicit options — the SDK reads no
// environment variables (spec/modes.md).
const runtime = new FireweaveRuntime(
  new FireweaveRemoteAdapter({
    apiUrl: process.env.FW_API_URL!,
    apiKey: process.env.FW_PROJECT_API_KEY!,
  }),
);
const fireweave = new FireweaveClient(runtime);
await fireweave.initialize();

// Once per login: the durable facts your targeting rules match on.
await runtime.registerTarget('user_42', {
  kind: 'user',
  properties: { plan: 'pro', region: 'eu-west' },
});

// Per request.
const enabled = await fireweave.controlPoints.getBooleanValue('new-checkout', false, {
  targetingKey: 'user_42',
});

fireweave.signals.recordOutcome({ name: 'checkout', status: 'completed' });
await fireweave.shutdown();   // flushes queued exposures first
```

## Quick start (offline, in-memory)

```ts
import { FireweaveClient, FireweaveRuntime, InMemoryAdapter } from '@fireweaveai/server-sdk';

const runtime = new FireweaveRuntime(new InMemoryAdapter({
  flags: { 'new-checkout': { type: 'boolean', enabled: true, value: true, variant: 'on' } },
}));
await runtime.initialize();
const fireweave = new FireweaveClient(runtime);

// → true
await fireweave.controlPoints.getBooleanValue('new-checkout', false, { targetingKey: 'u1' });
```

## OpenFeature

```ts
import { OpenFeature } from '@openfeature/server-sdk';
import { FireweaveProvider, FireweaveRuntime, InMemoryAdapter } from '@fireweaveai/server-sdk';

const runtime = new FireweaveRuntime(new InMemoryAdapter({ flags: { /* … */ } }));
await OpenFeature.setProviderAndWait(new FireweaveProvider(runtime));

const enabled = await OpenFeature.getClient()
  .getBooleanValue('new-checkout', false, { targetingKey: 'user_42' });

await OpenFeature.close();
```

The per-call parameter is `flagKey`, not `controlPointKey` — that name is fixed by the OpenFeature specification, by `spec/decision.schema.json`, and by the wire protocol shared with the Python, Go, and Java SDKs. "Control point" is the product noun; `flagKey` is its key at those boundaries ([ADR-0007](../../docs/adr/0007-control-point-vocabulary.md)).

## Module layout

| Module | Responsibility |
| --- | --- |
| `application/runtime.ts` | Lifecycle state machine, config validation, context policy, decision construction. Evaluation never throws. |
| `application/client.ts` | `FireweaveClient` — `controlPoints`, `releases`, `exposures`, `signals`, `guardrails` (stub), `capabilities`. |
| `provider.ts` | OpenFeature server provider; the only module importing `@openfeature/server-sdk`. |
| `infrastructure/adapters/remote.ts` | `FireweaveRemoteAdapter` — the production backend (`/v1/flags/evaluate`, `/v1/capture`, `/v1/targets/register`). |
| `infrastructure/adapters/inmemory.ts` | Deterministic fixture-driven adapter for tests and conformance. |
| `application/ports.ts` | The `BackendAdapter` boundary. Adapters never see OpenFeature types. |
| `domain/context.ts` | Merge order (global → client → invocation), deep copy, bounds, reserved keys. |
| `domain/errors.ts` | The 15-kind error taxonomy and secret redaction. |
| `infrastructure/hosts.ts` | SSRF allowlist (on by default; https required off-loopback). |

## Configuration

The SDK reads no environment variables (spec/modes.md, unscoped) — every option below is an explicit constructor argument.

| Option | Description |
| --- | --- |
| `apiUrl` | fw-server base URL (required) |
| `apiKey` | Fireweave project key (`project-api-key_…`) (required) |
| `requestTimeoutMs` | per-request deadline (default 3000) |
| `allowedHosts` | SSRF allowlist override; defaults to the `apiUrl` host plus loopback |

---

# Upgrading from v2.0 to 2.1

**Only one change is mandatory.** If you imported the direct vendor adapter, swap it. Everything else from v2 still works, so most of this section exists to tell you what you *don't* have to do.

## Does this affect me?

```bash
# Mandatory to fix (any hit ⇒ migration required)
rg -n "@fireweaveai/server-sdk/posthog|PostHogAdapter"
rg -n '"posthog-node"' package.json

# Configuration that moves
rg -n "POSTHOG_HOST|POSTHOG_API_KEY|POSTHOG_PROJECT_API_KEY"
```

No hits? Bump the version; you are done.

## 1. Swap the adapter (required)

```ts
// before
import { PostHogAdapter } from '@fireweaveai/server-sdk/posthog';
const adapter = new PostHogAdapter({
  projectApiKey: process.env.POSTHOG_API_KEY,
  host: process.env.POSTHOG_HOST,
  featureFlagsRequestTimeoutMs: 3000,
});

// after
import { FireweaveRemoteAdapter } from '@fireweaveai/server-sdk';
const adapter = new FireweaveRemoteAdapter({
  apiUrl: process.env.FW_API_URL,
  apiKey: process.env.FW_PROJECT_API_KEY,
  requestTimeoutMs: 3000,
});
```

| v2 option | 2.1 |
| --- | --- |
| `projectApiKey` (`phc_…`) | `apiKey` (`project-api-key_…`) |
| `host` | `apiUrl` |
| `featureFlagsRequestTimeoutMs` | `requestTimeoutMs` |
| `shutdownTimeoutMs`, `allowedHosts` | unchanged |
| `secretApiKey`, `onlyEvaluateLocally`, `featureFlagsPollingInterval`, `waitForLocalDefinitions`, `client` | **no equivalent** — see §4 |

Then:

- Remove `posthog-node` from `package.json` — **unless** you use it for your own analytics capture. Check with `rg "posthog-node"` first.
- Drop `projectApiKey`/`host` from `FireweaveRuntimeConfig` if they were only there to satisfy the old adapter's validation. Keep `host` if you want the runtime-level allowlist check.
- Update deployment config, secret stores, and CI: `POSTHOG_HOST` → `FW_API_URL`, `POSTHOG_API_KEY` → `FW_PROJECT_API_KEY`. **The new key is a Fireweave project key, not a re-labelled vendor key** — it has to be issued from your Fireweave project.

## 2. What you do *not* have to change

| v2 | Status in 2.1 |
| --- | --- |
| `client.flags.evaluate` / `getBooleanValue` / … | works — the same object as `client.controlPoints` |
| `new InMemoryAdapter({ flags })` | unchanged |
| `Decision.flagKey`, `Exposure.flagKey`, `flagMetadata` | unchanged |
| `FlagValueType`, `InMemoryFlagDefinition`, `ExpectedFlagType` | unchanged |
| `capabilities.get().static.features.flags` | still `true` (`controlPoints: true` added beside it) |
| every other v2 export | unchanged |

`client.flags === client.controlPoints` — a getter returning the same instance, not a copy. It is marked `@deprecated` in JSDoc and **is not scheduled for removal in the 2.x line**; retiring it would need its own major and its own ADR. Renaming your call sites is cosmetic and can be deferred indefinitely.

The whole v2 surface is pinned by `test/compat/v2-surface.compat.test.ts` (runtime exports and behavior) and `test/compat/v2-types.compat.ts` (~40 type exports, checked by `tsc --noEmit`), so it cannot regress silently.

The first time your process accesses `client.flags`, it logs one notice to `console.warn` — never more than once per process, because a per-call warning at request volume is how deprecation notices get suppressed wholesale and then ignored. This is unconditional (the SDK reads no environment variables, spec/modes.md); there is no flag to silence it beyond not using `client.flags`.

## 3. Two type-level narrowings

`'posthog'` is no longer a member of `BackendAdapter['name']` or `Capabilities['runtime']['backend']`.

- A custom adapter declaring `name: 'posthog'` → use `'other'`.
- An exhaustive `switch` on `backend` with a `case 'posthog'` → that arm is unreachable; remove it.

Both are rare, and `tsc` points straight at them.

## 4. Local evaluation is gone

v2's vendor adapter could evaluate in-process from polled definitions with a secret key. 2.1 has no equivalent: caching is fw-server's concern, and both shipped adapters report `localEvaluation: false`.

If in-process evaluation is load-bearing for you — an air-gapped service, or a latency floor below one network hop — **stay on v2 for now and tell us**. The interface seam (`AdapterRuntimeFeatures.localEvaluation` / `localOnly`, `AdapterResolution.fromCache`, the `STALE` reason) is deliberately preserved for a future Fireweave-native cache ([ADR-0006](../../docs/adr/0006-node-drops-direct-posthog-adapter.md)).

## 5. Worth re-checking

1. **`DEFAULT_ALLOWED_HOSTS` changed contents** while keeping its name. It now lists Fireweave hosts, not vendor hosts. Code doing `allowedHosts: [...DEFAULT_ALLOWED_HOSTS, 'mine.example']` keeps compiling and silently stops permitting the old endpoints. That is intended — verify it matches your deployment.
2. **Move durable attributes to `registerTarget`.** Attributes you resend on every evaluation can be registered once per login. Per-request attributes still override stored properties, so the two compose — this is an optimization, not a cutover. Note that `registerTarget` returns `{ ok }` rather than throwing (it sits in sign-in paths); log `ok: false`, because a silently unregistered target is exactly how targeting rules end up matching nobody.
3. **`sdkVersion` is now accurate.** `capabilities.get().static.sdkVersion` returned `0.1.0` in v2 regardless of the package version; it now tracks `package.json` and is pinned by a test.

## 6. Verify

```bash
npm install @fireweaveai/server-sdk@^3
npx tsc --noEmit                                  # catches §3
<your test command>
rg -n "@fireweaveai/server-sdk/posthog|PostHogAdapter"   # expect no hits
```

At runtime:

```ts
const caps = client.capabilities.get();
// backend:                'fireweave'   (was 'posthog')
// localEvaluation:        false
// features.flags:         true          ← must still be true
// features.controlPoints: true
```

If `backend` is still `'inmemory'` somewhere you expected to be live, the remote adapter was never wired in — check which adapter the runtime was constructed with.

## Rollback

```bash
npm install @fireweaveai/server-sdk@2   # re-add posthog-node if you removed it
```

Revert the adapter swap and the env vars. No data migration is involved, so rollback is code and config only.

---

## Renaming `flags` → `controlPoints` safely

If you do decide to adopt the new name, scope the edit. `flags` is an ordinary word: your repo very likely contains feature-flag code, config keys, DB columns, and `flags` variables that have nothing to do with this SDK.

**Rename only `.flags` accesses whose receiver is provably a `FireweaveClient`** — traceable to a `new FireweaveClient(...)`, an imported binding assigned from one, or a parameter annotated `FireweaveClient`.

Never rename:

| Looks similar | Why it stays |
| --- | --- |
| `new InMemoryAdapter({ flags: … })` | SDK option key, unchanged |
| `flagKey`, `flagMetadata`, `FlagValueType`, `InMemoryFlagDefinition` | SDK API, unchanged |
| `ofClient.getBooleanValue(...)` | the OpenFeature client, not the Fireweave client |
| `features.flags` in the capability matrix | still `true`; removing it fails conformance |
| your own `flags` variables, `featureFlags`, CLI `--flags`, `flags` columns | not this SDK |
| another vendor's SDK (`ldClient.variation`, flagd, Unleash) | not this SDK |

**Do not run a repo-wide `flags` → `controlPoints` replacement** — not with `sed`, not with editor replace-all. Go call site by call site, and when a receiver is ambiguous, leave it. A missed cosmetic rename costs nothing; a wrong one breaks unrelated code.

## Development

```bash
npm install          # from sdks/node
npm run build        # emit dist/ (package exports resolve to it)
npm run verify       # typecheck + unit + integration + compat + conformance + smoke
npm run smoke        # cross-runtime smoke (Node leg)

bun test test/unit test/integration test/compat
bun  scripts/smoke-runtimes.mjs
deno run --allow-read scripts/smoke-runtimes.mjs
```

## Documentation

Full docs live in [`docs/`](../../docs/): [quickstart](../../docs/quickstart.md) · [remote adapter](../../docs/remote.md) · [extensions](../../docs/extensions.md) · [OpenFeature](../../docs/openfeature.md) · [runtimes](../../docs/runtimes.md) · [testing](../../docs/testing.md) · [migration](../../docs/migration.md) · [troubleshooting](../../docs/troubleshooting.md) · [ADRs](../../docs/adr/).

## License

[MIT](../../LICENSE).
