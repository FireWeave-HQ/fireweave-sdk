# ADR-0008: The Node SDK targets Node, Bun, and Deno

- **Status:** Accepted
- **Date:** 2026-08-08
- **Scope:** `sdks/node` (the package published as `@fireweaveai/sdk`)
- **Related:** ADR-0004 (server-first), ADR-0006 (Node drops the direct PostHog adapter)

## Context and Problem Statement

The package was written for Node (`engines.node >= 20.20`) and gated only on Node in CI. In practice it was already close to runtime-agnostic: the transport is `fetch`, cancellation is `AbortController`, and there are no Node built-in imports in `src/`.

Two Node-isms stood in the way, and both had the same failure signature — working on Node *and* Bun, failing only on Deno, so CI could never see it:

1. `Buffer.byteLength(s, 'utf8')` in `context.ts`, on the per-evaluation context bound check. `Buffer` is a Node global; Deno provides it only under npm compatibility.
2. `process.env[...]` in the remote adapter. Deno exposes `process` but the idiomatic `Deno.env.get` **throws** without `--allow-env` — so a Deno user passing `apiUrl`/`apiKey` explicitly could still be broken by a permission they did not need.

Removing a vendor SDK dependency in ADR-0006 also removed the last thing tying the package to the npm runtime: with `@openfeature/server-sdk` as the only peer dependency and zero runtime dependencies, "runs anywhere" became cheap to claim and cheap to verify.

## Decision

Support **Node ≥ 20.20, Bun ≥ 1.2, and Deno ≥ 2.0**, and gate all three in CI.

- `Buffer.byteLength` → `TextEncoder().encode().length`.
- Direct `process.env` reads → `readEnv()` in `src/env.ts`, which tries `process.env`, then `Deno.env.get`, and treats a thrown permission error as *absence*. A denied permission must never turn into a construction failure.
- `src/` stays free of `node:` imports and Node globals, enforced by `test/unit/runtime-portability.test.ts` — a static check on `src/`, because a Node-only CI cannot catch this class of regression by execution.
- One smoke script, `scripts/smoke-runtimes.mjs`, runs unchanged on all three. It imports deep **relative** paths so it contains no bare specifiers and needs no npm resolution on any runtime.

`engines` still declares only `node`, because npm has no field for Bun or Deno. The support claim lives in `docs/runtimes.md` and in CI.

## Coverage boundary (stated, not glossed)

The Deno job typechecks the build and runs the smoke, which covers every module **except** `provider.js` — the OpenFeature provider, whose `@openfeature/server-sdk` import is a bare npm specifier that would require Deno's npm resolution.

So: the Fireweave-native surface is asserted on all three runtimes. The OpenFeature provider path is asserted on Node and Bun. Deno users going through the OpenFeature client rely on Deno's npm compatibility layer, which is well-supported but not gated by this repo.

Extending the Deno job to cover the provider means adding npm resolution to it. That is a deliberate follow-up, not an oversight.

## Consequences

- Three runtimes × two versions each is four new CI jobs. They are fast (no service containers, no matrix explosion beyond version pairs).
- The Deno legs run twice, with and without `--allow-env`, because the permission-denied path is exactly the one that regressed most easily.
- `Buffer` and `process` are now bannable in `src/`, which is a real constraint on future contributions. The portability test names the replacement in its failure message so the constraint is actionable rather than mysterious.
