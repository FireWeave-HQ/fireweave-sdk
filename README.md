# Fireweave SDK

**The AI Release Engineer SDK.** Server-side (and browser) release safety for progressive
delivery: define **control points** in your code and **register** who you are targeting. Exactly
two v1 capabilities ([spec/control-points.md](spec/control-points.md) "Scope of v1") — nothing
else is in scope, and no SDK exposes an OpenFeature provider.

Available for **Node.js, web (browser), Python, Go, Java, Rust, Swift, and Dart**. The Node
package runs on **Node, Bun, and Deno**; the Dart package runs in **Flutter apps on Android, iOS,
macOS, Windows, Linux, and web**, on the Dart VM, and compiled to JavaScript or WebAssembly.

```
Control points  evaluate boolean / string / number / object decisions, never throw
Targets         register durable targeting properties once, at login
```

Applications authenticate with a **Fireweave project key** and talk to **fw-server**. Which
analytics or flag backend fw-server forwards to is fw-server's concern — no third-party SDK,
key, or hostname ever enters your process ([ADR-0005](docs/adr/0005-fireweave-proxy-backend.md),
[ADR-0006](docs/adr/0006-node-drops-direct-posthog-adapter.md)).

> **Status: pre-release.** Node package `2.1.0`; spec `0.1.0`. Configure trusted publishers before the first non-dry-run release ([publish-readiness](docs/orchestration/publish-readiness.md)). **License:** [MIT](LICENSE).

## Install

```bash
npm install @fireweaveai/server-sdk   # or: bun add …
```

```ts
// Deno needs no install step
import { initFireweave } from 'npm:@fireweaveai/server-sdk';
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
```

Dart / Flutter (`fireweave` on pub.dev, **not published yet** — every Dart platform; synchronous
reads, safe inside `build()`; see [`sdks/dart/README.md`](sdks/dart/README.md)):

```yaml
dependencies:
  fireweave:
    path: ../fireweave-sdk/sdks/dart   # until `dart pub add fireweave` / `flutter pub add fireweave` resolves
```

Python, Go, Rust, Swift, and web — not yet published; see each SDK's own README
(`sdks/<lang>/README.md`) for the checkout-install path.

## Quickstart

```ts
import { initFireweave } from '@fireweaveai/server-sdk';

const fireweave = await initFireweave({
  mode: 'remote',
  apiUrl: process.env.FW_API_URL!,
  apiKey: process.env.FW_PROJECT_API_KEY!,
});

// Once per login: the durable facts your targeting rules match on.
await fireweave.registerTarget('user_42', {
  kind: 'user',
  properties: { plan: 'pro', region: 'eu-west', betaOptIn: true },
});

// Per request: evaluate a control point.
const enabled = await fireweave.controlPoints.getBooleanValue('new-checkout', false, {
  targetingKey: 'user_42',
});

await fireweave.shutdown();
```

`registerTarget` never throws — it sits in sign-in paths, and a targeting call must not break a
login. It returns `{ ok }` so a careful caller can log a failure, because a silently unregistered
target is exactly how targeting rules end up matching nobody.

Full walkthroughs, including Python, Go, Java, Rust, and Swift: **[docs/quickstart.md](docs/quickstart.md)**. Runnable examples: **[`examples/`](examples/)** (offline by default).

## Configuration

Every SDK reads no environment variables — credentials and options are explicit arguments to the
single entry point (`initFireweave` / `init_fireweave` / `Fireweave.init` / `fireweave.Init`).

| Option | Description |
| --- | --- |
| `apiUrl` | fw-server base URL (required for remote mode) |
| `apiKey` | Fireweave project key (`project-api-key_…`) (required for remote mode) |
| `allowedHosts` | SSRF allowlist override; defaults to the configured host plus loopback |

`https` is required for anything that leaves the machine; plain `http` is permitted on loopback only, for the local test stub.

## Testing

`InMemoryAdapter` gives deterministic, offline evaluation with no network and no backend:

```ts
import { FireweaveClient, FireweaveRuntime, InMemoryAdapter } from '@fireweaveai/server-sdk';

const runtime = new FireweaveRuntime(new InMemoryAdapter({
  flags: {
    'new-checkout': { type: 'boolean', enabled: true, value: true, variant: 'on' },
    'checkout-theme': {
      type: 'string', enabled: true, value: 'midnight', variant: 'midnight',
      matchAttribute: { cohort: 'beta' },     // only the beta cohort matches
    },
  },
}));
const fireweave = new FireweaveClient(runtime);
await fireweave.initialize();
```

Or the offline mode built into `initFireweave` (`{ mode: 'local', local: { controlPoints: { 'new-checkout': true } } }`) — no adapter construction required.

Patterns and the protocol test stub: **[docs/testing.md](docs/testing.md)**.

## Runtimes

| Runtime | Minimum | CI |
| --- | --- | --- |
| Node.js | 20.20 | full suite on 20 and 24 |
| Bun | 1.2 | full suite on 1.2 and latest |
| Deno | 2.0 | typecheck + cross-runtime smoke on `v2.x` and canary |

Zero runtime dependencies, no Node built-ins, no Node globals. Details and the coverage boundary: **[docs/runtimes.md](docs/runtimes.md)**.

## Upgrading from v2

Only one thing is mandatory: if you imported `PostHogAdapter` from `@fireweaveai/server-sdk/posthog`, switch to `FireweaveRemoteAdapter` (or `initFireweave({ mode: 'remote', ... })`). Everything else keeps working — `client.flags` still exists and is identical to `client.controlPoints`, and no type or option was renamed.

Step-by-step, including what *not* to change and how to scope a `flags` → `controlPoints` rename safely: **[the Node module README](sdks/node/README.md#upgrading-from-v20-to-21)**. Cross-language migration notes: [docs/migration.md](docs/migration.md).

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/quickstart.md](docs/quickstart.md) | Five-minute path per language |
| [docs/remote.md](docs/remote.md) | The backend adapter, wire protocol, local stub |
| [docs/runtimes.md](docs/runtimes.md) | Node / Bun / Deno support and what makes it portable |
| [docs/testing.md](docs/testing.md) | `InMemoryAdapter` patterns and the protocol test server |
| [docs/extensions.md](docs/extensions.md) | Pre-v1 release lifecycle / exposures / signals surface (pending rewrite — see note below) |
| [docs/openfeature.md](docs/openfeature.md) | Pre-v1 OpenFeature provider docs (pending rewrite — no SDK exposes an OpenFeature provider in v1) |
| [docs/identity.md](docs/identity.md) | Targeting keys, anonymous strategy, groups |
| [docs/concepts.md](docs/concepts.md) | Decision model, reasons, error taxonomy |
| [docs/lifecycle.md](docs/lifecycle.md) | Init, readiness, shutdown, after-shutdown behavior |
| [docs/migration.md](docs/migration.md) | From v2; from a direct vendor SDK |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Common failure modes and what they mean |
| [docs/compatibility.md](docs/compatibility.md) | Per-language version and feature matrix, known gaps |
| [docs/versioning.md](docs/versioning.md) | Semver policy, spec version, deprecation policy |
| [docs/architecture.md](docs/architecture.md) | Layers, lifecycle, data model, ADR index |
| [docs/privacy.md](docs/privacy.md) | What the SDK sends, and when |

Some pages under `docs/` still describe pre-v1 capabilities (OpenFeature providers, release
lifecycle, exposures, signals) pending a dedicated rewrite pass — treat `spec/control-points.md`
and each SDK's own README (`sdks/<lang>/README.md`) as the current source of truth in the
meantime.

## Repository layout

```
sdks/node|web|python|go|java|rust|swift|dart   Language SDKs (each with its own tests + conformance harness)
examples/<lang>                           Runnable examples (offline by default)
spec/                                     Canonical JSON Schemas (v0.1.0) — source of truth
contracts/                                Cross-language conformance fixtures + error taxonomy
test-server/                              Deterministic protocol stub (Node, zero-dep)
docs/                                     User docs, architecture, ADRs
```

Conformance: the same 65 fixtures run against all eight languages via
`scripts/conformance-all.sh` — see [docs/compatibility.md](docs/compatibility.md) for the current
per-language pass/skip detail.

## Contributing

Contributions are accepted under the **Developer Certificate of Origin** (sign-off, not a CLA) — see [CONTRIBUTING.md](CONTRIBUTING.md), the [Code of Conduct](CODE_OF_CONDUCT.md), and [GOVERNANCE.md](GOVERNANCE.md). Vulnerability reports: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) — ratification of the license choice is pending a company decision; do not redistribute packages built from this repository until the license is ratified and publication is authorized.
