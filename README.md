# Fireweave SDK

**The AI Release Engineer SDK.** Server-side release safety for progressive delivery: define **control points** in your code, register who you are targeting, drive a release through its lifecycle, and report what actually happened — exposures, health, errors, outcomes.

Available for **Node.js, Python, Go, and Java**. The Node package runs on **Node, Bun, and Deno**.

```
Control points  evaluate boolean / string / number / object decisions
Targets         register durable targeting properties once, at login
Releases        rollout-aware set → start → complete / fail
Exposures       deduplicated, batched, flushed on your terms
Signals         health · error · metric · outcome
Capabilities    ask the SDK what this build can do
OpenFeature     read control points through the standard client
```

Applications authenticate with a **Fireweave project key** and talk to **fw-server**. Which analytics or flag backend fw-server forwards to is fw-server's concern — no third-party SDK, key, or hostname ever enters your process ([ADR-0005](docs/adr/0005-fireweave-proxy-backend.md), [ADR-0006](docs/adr/0006-node-drops-direct-posthog-adapter.md)).

> **Status: pre-release.** Node package `2.1.0`; spec `0.1.0`. Configure trusted publishers before the first non-dry-run release ([publish-readiness](docs/orchestration/publish-readiness.md)). **License:** [MIT](LICENSE).

## Install

```bash
npm install @fireweaveai/server-sdk @openfeature/server-sdk   # or: bun add …
```

```ts
// Deno needs no install step
import { FireweaveClient, FireweaveRemoteAdapter, FireweaveRuntime } from 'npm:@fireweaveai/server-sdk';
```

Not yet published — until then, install from a checkout: `cd sdks/node && npm install && npm run build`.

Java (`ai.fireweave:*`, **not on Maven Central yet**):

```bash
cd sdks/java && mvn install
```

```xml
<dependency>
  <groupId>ai.fireweave</groupId>
  <artifactId>fireweave-sdk</artifactId>
  <version>0.1.0-SNAPSHOT</version>
</dependency>
<dependency>
  <groupId>ai.fireweave</groupId>
  <artifactId>fireweave-openfeature</artifactId>
  <version>0.1.0-SNAPSHOT</version>
</dependency>
```

## Quickstart

```ts
import { FireweaveClient, FireweaveRemoteAdapter, FireweaveRuntime } from '@fireweaveai/server-sdk';

// Reads FW_API_URL and FW_PROJECT_API_KEY when not passed explicitly.
const runtime = new FireweaveRuntime(new FireweaveRemoteAdapter());
const fireweave = new FireweaveClient(runtime);
await fireweave.initialize();

// Once per login: the durable facts your targeting rules match on.
await runtime.registerTarget('user_42', {
  kind: 'user',
  properties: { plan: 'pro', region: 'eu-west', betaOptIn: true },
});

// Per request: evaluate a control point.
const enabled = await fireweave.controlPoints.getBooleanValue('new-checkout', false, {
  targetingKey: 'user_42',
});

// Report what happened.
fireweave.signals.recordOutcome({ name: 'checkout', status: 'completed' });

await fireweave.shutdown(); // flushes queued exposures first
```

`registerTarget` never throws — it sits in sign-in paths, and an analytics call must not break a login. It returns `{ ok }` so a careful caller can log a failure, because a silently unregistered target is exactly how targeting rules end up matching nobody.

Full walkthroughs, including Python, Go, and Java: **[docs/quickstart.md](docs/quickstart.md)**. Runnable examples: **[`examples/`](examples/)** (offline by default).

## Configuration

| Option | Environment | Description |
| --- | --- | --- |
| `apiUrl` | `FW_API_URL` | fw-server base URL |
| `apiKey` | `FW_PROJECT_API_KEY` | Fireweave project key (`project-api-key_…`) |
| `requestTimeoutMs` | — | per-request deadline (default 3000) |
| `allowedHosts` | — | SSRF allowlist override; defaults to the configured host plus loopback |

`https` is required for anything that leaves the machine; plain `http` is permitted on loopback only, for the local test stub.

## Reading control points through OpenFeature

OpenFeature is one supported way to evaluate — useful when you want your call sites to depend on a standard API rather than on Fireweave types, or when you already have OpenFeature hooks and domains in place. The Fireweave-native surface (releases, exposures, signals, targets, capabilities) lives on `FireweaveClient` and never contaminates the standard evaluation path ([ADR-0003](docs/adr/0003-openfeature-boundary.md)).

```ts
import { OpenFeature } from '@openfeature/server-sdk';
import { FireweaveProvider, FireweaveRuntime, InMemoryAdapter } from '@fireweaveai/server-sdk';

const runtime = new FireweaveRuntime(new InMemoryAdapter({
  flags: { 'new-checkout': { type: 'boolean', enabled: true, value: true, variant: 'on' } },
}));
await OpenFeature.setProviderAndWait(new FireweaveProvider(runtime));

const enabled = await OpenFeature.getClient()
  .getBooleanValue('new-checkout', false, { targetingKey: 'user_42' });

await OpenFeature.close();
```

The per-call parameter is `flagKey`, not `controlPointKey` — that name is fixed by the OpenFeature specification, by the canonical schemas in [`spec/`](spec/), and by the wire protocol shared with the other three SDKs. "Control point" is the product noun; `flagKey` is its key at those boundaries. [ADR-0007](docs/adr/0007-control-point-vocabulary.md) records exactly where each term applies.

## Testing

`InMemoryAdapter` gives deterministic, offline evaluation with no network and no backend:

```ts
const runtime = new FireweaveRuntime(new InMemoryAdapter({
  flags: {
    'new-checkout': { type: 'boolean', enabled: true, value: true, variant: 'on' },
    'checkout-theme': {
      type: 'string', enabled: true, value: 'midnight', variant: 'midnight',
      matchAttribute: { cohort: 'beta' },     // only the beta cohort matches
    },
  },
}));
```

Patterns and the protocol test stub: **[docs/testing.md](docs/testing.md)**.

## Runtimes

| Runtime | Minimum | CI |
| --- | --- | --- |
| Node.js | 20.20 | full suite on 20 and 24 |
| Bun | 1.2 | full suite on 1.2 and latest |
| Deno | 2.0 | typecheck + cross-runtime smoke on `v2.x` and canary |

Zero runtime dependencies, one peer dependency (`@openfeature/server-sdk`), no Node built-ins, no Node globals. Details and the coverage boundary: **[docs/runtimes.md](docs/runtimes.md)**.

## Upgrading from v2

Only one thing is mandatory: if you imported `PostHogAdapter` from `@fireweaveai/server-sdk/posthog`, switch to `FireweaveRemoteAdapter`. Everything else keeps working — `client.flags` still exists and is identical to `client.controlPoints`, and no type or option was renamed.

Step-by-step, including what *not* to change and how to scope a `flags` → `controlPoints` rename safely: **[the Node module README](sdks/node/README.md#upgrading-from-v20-to-21)**. Cross-language migration notes: [docs/migration.md](docs/migration.md).

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/quickstart.md](docs/quickstart.md) | Five-minute path per language |
| [docs/remote.md](docs/remote.md) | The backend adapter, wire protocol, local stub |
| [docs/extensions.md](docs/extensions.md) | Releases, exposures, signals, guardrails, capabilities |
| [docs/openfeature.md](docs/openfeature.md) | Resolvers, detailed resolution, context, domains, hooks |
| [docs/runtimes.md](docs/runtimes.md) | Node / Bun / Deno support and what makes it portable |
| [docs/testing.md](docs/testing.md) | `InMemoryAdapter` patterns and the protocol test server |
| [docs/identity.md](docs/identity.md) | Targeting keys, anonymous strategy, groups |
| [docs/concepts.md](docs/concepts.md) | Decision model, reasons, error taxonomy, capability matrix |
| [docs/lifecycle.md](docs/lifecycle.md) | Init, readiness, shutdown, after-shutdown behavior |
| [docs/migration.md](docs/migration.md) | From v2; from a direct vendor SDK; from another OpenFeature provider |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Common failure modes and what they mean |
| [docs/compatibility.md](docs/compatibility.md) | Per-language version and feature matrix, known gaps |
| [docs/versioning.md](docs/versioning.md) | Semver policy, spec version, deprecation policy |
| [docs/architecture.md](docs/architecture.md) | Layers, lifecycle, data model, ADR index |
| [docs/privacy.md](docs/privacy.md) | What the SDK sends, and when |

## Repository layout

```
sdks/node|python|go|java   Language SDKs (each with its own tests + conformance harness)
examples/<lang>            Runnable examples (offline by default)
spec/                      Canonical JSON Schemas (v0.1.0) — source of truth
contracts/                 Cross-language conformance fixtures + error taxonomy
test-server/               Deterministic protocol stub (Node, zero-dep)
docs/                      User docs, architecture, ADRs
```

Conformance: **65** shared fixtures. Python 65/65, Go 65/65, Java 64/65 (+1 numeric skip), Node 63/65 (+2 numeric skips) — every skip is a pre-declared, documented numeric-representation limitation ([docs/compatibility.md](docs/compatibility.md)).

## Contributing

Contributions are accepted under the **Developer Certificate of Origin** (sign-off, not a CLA) — see [CONTRIBUTING.md](CONTRIBUTING.md), the [Code of Conduct](CODE_OF_CONDUCT.md), and [GOVERNANCE.md](GOVERNANCE.md). Vulnerability reports: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) — ratification of the license choice is pending a company decision; do not redistribute packages built from this repository until the license is ratified and publication is authorized.
