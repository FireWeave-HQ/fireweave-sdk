# Runtimes: Node, Bun, Deno

`@fireweaveai/sdk` is published as a runtime-agnostic ESM package. It uses no Node built-in modules and no Node globals, so the same build runs on all three server runtimes ([ADR-0008](adr/0008-multi-runtime-support.md)).

## Support matrix

| Runtime | Minimum | Gated in CI | Notes |
| --- | --- | --- | --- |
| Node.js | 20.20 (`engines`) | full suite on 20 and 24 | reference runtime |
| Bun | 1.2 | full suite on 1.2 and latest | use `bun test`, not `bun <file>`, for suites written against `node:test` |
| Deno | 2.0 | typecheck + cross-runtime smoke on `v2.x` and canary | install via the `npm:` specifier |

## Install

```bash
# Node
npm install @fireweaveai/sdk @openfeature/server-sdk

# Bun
bun add @fireweaveai/sdk @openfeature/server-sdk
```

```ts
// Deno — no install step
import { FireweaveClient, FireweaveRemoteAdapter, FireweaveRuntime } from 'npm:@fireweaveai/sdk';
```

Deno needs `--allow-net` to reach fw-server, and `--allow-env` only if you let the adapter read `FW_API_URL` / `FW_PROJECT_API_KEY` from the environment:

```bash
deno run --allow-net --allow-env server.ts
```

Passing `apiUrl` and `apiKey` explicitly means `--allow-env` is not required at all. The SDK's environment lookup is guarded: without the permission it reports the variable as absent rather than throwing, so a fully-configured adapter never fails on a permission it does not need.

## What makes it portable

Two Node-isms were removed in 2.1, both of which would have worked on Node and Bun and failed only on Deno:

| Was | Now | Why |
| --- | --- | --- |
| `Buffer.byteLength(s, 'utf8')` | `new TextEncoder().encode(s).length` | `Buffer` is a Node global; Deno exposes it only under npm compatibility. This runs on every context bound check. |
| `process.env['FW_API_URL']` | `readEnv('FW_API_URL')` | `Deno.env.get` throws without `--allow-env`; the helper tries `process.env`, then `Deno.env`, and treats a denied permission as absence. |

The SDK depends only on platform primitives every target provides: `fetch`, `AbortController`, `URL`, `TextEncoder`, and timers.

`packages/sdk/test/unit/runtime-portability.test.ts` fails the build if a `Buffer.` reference, a bare `process.env` read, or a `node:` import reappears in `src/` — a regression that CI on Node alone could not see.

## Coverage boundary

The Deno job runs `scripts/smoke-runtimes.mjs`, which imports deep relative paths and therefore carries no bare specifiers — no npm resolution needed.

That covers every module **except** `provider.js`, the OpenFeature provider, whose `@openfeature/server-sdk` import is a bare npm specifier. That module is gated by the Node and Bun jobs. If you use the SDK on Deno through the OpenFeature client, resolution goes through Deno's npm compatibility layer, which is well-supported but not asserted by this repo's CI.

The Fireweave-native surface — control points, targets, releases, exposures, signals, capabilities — is fully covered on all three runtimes.

## Running the smoke locally

```bash
cd sdks/node && npm run build

node scripts/smoke-runtimes.mjs
bun  scripts/smoke-runtimes.mjs
deno run --allow-read scripts/smoke-runtimes.mjs
```

`npm run verify` includes the Node leg.
