# Runtimes: Node, Bun, Deno

The Node SDK (`@fireweaveai/server-sdk`) uses no Node built-in modules and no Node globals, so the same build runs on all three server runtimes ([ADR-0008](adr/0008-multi-runtime-support.md)).

## Support matrix

| Runtime | Minimum | Gated in CI | Notes |
| --- | --- | --- | --- |
| Node.js | 20.20 (`engines`) | full suite on 20 and 24 | reference runtime |
| Bun | 1.2 | cross-runtime smoke on 1.2 and latest | use `bun test`, not `bun <file>`, for suites written against `node:test` |
| Deno | 2.0 | typecheck + cross-runtime smoke on `v2.x` and canary | install via the `npm:` specifier |

## What makes it portable

One Node-ism was removed in 2.1, which would have worked on Node and Bun and failed only on Deno:

| Was | Now | Why |
| --- | --- | --- |
| `Buffer.byteLength(s, 'utf8')` | `new TextEncoder().encode(s).length` | `Buffer` is a Node global; Deno exposes it only under npm compatibility. This runs on every context bound check. |

The SDK depends only on platform primitives every target provides: `fetch`, `AbortController`, `URL`, `TextEncoder`, and timers.

`sdks/node/test/unit/runtime-portability.test.ts` fails the build if a `Buffer.` reference, a bare `process.env` read, or a `node:` import reappears in `src/` — a regression that CI on Node alone could not see.

## Coverage boundary

The Deno job runs `scripts/smoke-runtimes.mjs`, which imports deep relative paths and therefore carries no bare specifiers — no npm resolution needed.

The Fireweave-native surface — control points, targets — is fully covered on all three runtimes.

## Running the smoke locally

```bash
cd sdks/node && npm run build

node scripts/smoke-runtimes.mjs
bun  scripts/smoke-runtimes.mjs
deno run --allow-read scripts/smoke-runtimes.mjs
```

`npm run verify` includes the Node leg.
