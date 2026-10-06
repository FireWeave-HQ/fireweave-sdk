# @fireweaveai/web-sdk (Web SDK)

Fireweave control points for the browser ([ADR-0009](../../docs/adr/0009-browser-control-points.md)) —
**control points** and **target registration**, the two v1 capabilities
([spec/control-points.md](../../spec/control-points.md) "Scope of v1"; spec v0.1.0).

- **Secret-free by construction.** No vendor SDK dependency, no environment reads, and vendor/secret key shapes are rejected at the door.
- **Reads are synchronous** — `controlPoints.getBooleanValue(...)` returns a value directly, no `await`, safe inside a render path. `initFireweave` prefetches a decision cache once per context; reads afterward are a pure in-memory lookup.
- **Bun is the toolchain.** The browser code is tested on Bun with happy-dom. It reads no environment and imports no runtime built-ins, so Node/Deno are not target runtimes for it. The two build-time entries, `/vite` and `/define`, run in Node while your bundler loads its config, and never ship to the browser.

## Install

```bash
bun add @fireweaveai/web-sdk   # or: npm install @fireweaveai/web-sdk
```

## Quick start (one line: the start profile)

The start profile ([ADR-0012](../../docs/adr/0012-start-profile.md)) replaces the generated
`fw-harness.ts` / `fw-providers.ts` files with one plugin, one start file and one control-points file.
The core API below (`initFireweave`) is unchanged.

```ts
// vite.config.ts (Nuxt / Astro: the same call under the framework config's `vite.plugins`)
import { fireweave } from '@fireweaveai/web-sdk/vite';
export default defineConfig({ plugins: [react(), fireweave()] });

// src/fireweave/control-points.ts: every control point the app reads, with its local value
import { defineControlPoints } from '@fireweaveai/web-sdk/start';
export const controlPoints = defineControlPoints({
  'new-checkout': { local: true, description: 'New checkout flow' },
});

// src/fireweave/start.ts: imported first by your entry module
import { start } from '@fireweaveai/web-sdk/start';
import { controlPoints } from './control-points';
export const ready = start({ controlPoints });

// src/main.tsx: render once the first prefetch settles, so first render has decisions
import { ready } from './fireweave/start';
ready.then(() => createRoot(document.getElementById('root')!).render(<App />));
```

```ts
import { fw } from '@fireweaveai/web-sdk/start';

// @fireweave-controlpoint new-checkout
if (fw.controlPoints.getBooleanValue('new-checkout', false)) { /* synchronous, never throws */ }

await fw.identify(user.id, { plan: user.plan }); // sign-in / session restore
await fw.reset();                                  // sign-out: back to this browser's device id
fw.deviceId();                                     // the anonymous key, for analytics joins
fw.setPersistence('memory');                       // consent withdrawn; fw.forget() also mints a new id
fw.status();                                       // mode, channel, host, key source, problem; never the key
fw.subscribe((state) => rerender());               // fires on settle and after identify / reset
```

Set the browser key in the **build** environment (CI or the deploy's build step), not in a
developer `.env`, so `vite dev` stays local:

```bash
FIREWEAVE_BROWSER_KEY=fw_public_...
```

### Options and overrides

Each value resolves as: the `start()` option, then what the build helper injected, then the default.
The build helpers read the process environment and, for Vite, the app's `.env` files.

| `start()` option | Build variable | Default | Notes |
| --- | --- | --- | --- |
| `controlPoints` | — | `{}` | `defineControlPoints({...})` from `src/fireweave/control-points.ts`. Served in local mode only; a read of a key missing from it warns once. |
| `mode` | — | inferred | `'remote'` or `'local'`. Without it: a key means remote; no key and a development environment name means local; anything else fails closed. |
| `environment` | `FIREWEAVE_ENV`, then `APP_ENV` (the dev server and Vitest also use Vite's mode) | — | Only feeds the mode rule. A build never infers local from `--mode development`. |
| `url` | `FIREWEAVE_URL` | this SDK build's channel | `-staging.N` builds call `https://staging-app-server.fireweave.ai`, others `https://app-server.fireweave.ai`. Also accepts a same-origin proxy path such as `/fw`. https only, except localhost. |
| `key` | `FIREWEAVE_BROWSER_KEY` | — | A browser key (`fw_public_…`) only. Server keys (`project-api-key_…`), analytics vendor keys and org/CLI tokens are refused; messages name the source, never the value. |
| `persistence` | — | `'localStorage'` | `'memory'` stores nothing until `fw.setPersistence('localStorage')`. |
| `deviceId` | — | stored `dev_<uuid>` | An app-supplied anonymous id (for example the analytics id), used verbatim and not stored. |

`start()` never throws or rejects, so it cannot blank a page. A configuration fault logs one
`console.error`, sets `fw.status().state` to `FAILED` with a `problem`, and every read serves its
default. The build is where a fault fails loudly:

- **`fireweave()`** fails `vite build` (and the dev server) for a missing key outside development,
  a server key, a wrong key family, an http URL off localhost, or an `envPrefix` that would expose
  `FIREWEAVE_KEY`. After a client build it fails if any output file holds a server key.
- **Other bundlers** (Next.js, webpack, esbuild, Rollup) use `/define`, which has no `vite` import:

  ```ts
  // next.config.mjs
  import { fireweaveDefine } from '@fireweaveai/web-sdk/define';
  const define = fireweaveDefine(); // throws on the same faults; reads FIREWEAVE_ENV, APP_ENV, then NODE_ENV
  export default {
    webpack(config, { webpack }) {
      config.plugins.push(new webpack.DefinePlugin(define));
      return config;
    },
  };
  ```

  Without a build helper, pass `key` and `environment` to `start()` yourself.

Runtime faults keep their cause in `fw.status().problem`: `key-rejected` (fw-server answered 401/403)
and `unreachable` (offline, an ad or tracker blocker, a firewall, or a Content-Security-Policy
`connect-src` rule). Both leave the state `STALE` and reads on their defaults. Point `FIREWEAVE_URL`
at a same-origin proxy (`/fw`) that forwards `/v1/control-points/evaluate`, `/v1/capture` and
`/v1/targets/register` to avoid most of them.

On the server side of an SSR app, remote mode does nothing (a server-side singleton would share one
visitor's identity across requests) and reads return defaults; local mode serves the control-points object
everywhere, so server and client renders agree.

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
| `infrastructure/adapters/remote.ts` | `FireweaveRemoteWebAdapter` — the production backend (`/v1/control-points/evaluate`, `/v1/targets/register`). |
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
| `allowedHosts` | `remote` | SSRF allowlist override |
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
