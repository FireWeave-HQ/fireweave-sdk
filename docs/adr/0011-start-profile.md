# ADR-0011: A start profile for one-line setup, layered on an unchanged core

- **Status:** Proposed (node implemented on `feat/server-sdk-start-profile`; needs the cross-language sign-off GOVERNANCE.md requires before other SDKs follow)
- **Date:** 2026-10-02
- **Scope:** `@fireweaveai/server-sdk` first (Node, Bun, Deno). Other SDKs adopt the same rules later.
- **Related:** spec/modes.md (core reads no env, mode never inferred), spec/control-points.md (no invented targeting key), ADR-0008 (multi-runtime support)

## Context and Problem Statement

The core SDK is deliberately policy-free: it reads no environment variables, never infers
`mode`, and never invents an identity. Apps still need those answers, so the platform's
`/fireweave:initialise` skill generated them into every customer repo as a ~400-line
harness per surface. Those copies drift: a repo initialised in August still runs code the
platform removed weeks later. The answers are the same in every repo, so they belong in a
versioned package, not in generated files.

## Decision

Add an opt-in **start profile** beside the core, exported as `@fireweaveai/server-sdk/start`
(and `/register`, an env-only side-effect import). The core entrypoint `.` and `initFireweave`
do not change and still read no environment.

The start profile, and only it, may:

1. **Read the environment**, through one file (`src/start/env.ts`). Precedence for every value:
   explicit `start()` option, then `FIREWEAVE_*`, then the legacy `FW_*` name with one warning
   (read through 2.x), then the default. Empty values count as unset.
2. **Choose the mode by rule.** An explicit `mode` option wins. Otherwise a key means
   `remote`; no key and an environment name (`environment` option, `FIREWEAVE_ENV`,
   `APP_ENV`, `NODE_ENV`) of `development`, `dev`, `local` or `test` means `local`; anything
   else is a `Configuration` error at start. This keeps spec/modes.md's reason intact: a
   missing credential in production fails loudly and never becomes silent local evaluation.
3. **Default the endpoint from its own release channel.** `tools/release/version.sh apply
   server` stamps `src/start/build-info.ts`; a `-staging.N` build defaults to
   `https://staging-app-server.fireweave.ai`, any other to `https://app-server.fireweave.ai`.
   `url` / `FIREWEAVE_URL` override it, and the host allowlist follows the URL actually used.
4. **Check the key family** before any request: browser keys (`fw_public_`), analytics
   vendor keys, and org or CLI tokens are rejected at start, naming the source, never the value.
5. **Keep one process-wide client** (a `Symbol.for` slot on `globalThis`). A second `start()`
   with the same effective config is a no-op; a different one throws. Reads before `start()`
   schedule an env-only start on the next macrotask, which an entrypoint's own `start()` beats.
6. **Derive a server instance key** (`fw.instanceKey()`) from `instanceId`,
   `FIREWEAVE_INSTANCE_ID`, or a hash of the host name. Nothing is written to disk.
7. **Take local values from a flags object** (`start({ flags })`, conventionally
   `src/fireweave/flags.ts`). Values apply in local mode only; call sites keep `false` as
   their default, so the file can never switch a feature on in production.

Reads on `fw` never throw, matching spec/control-points.md: a failed start serves defaults
(and `ERROR` decisions for the `*Details` forms).

## Consequences

- Customer repos carry one import, one secret (`FIREWEAVE_KEY`) and one flags file instead of a
  generated harness. Fixes ship as package versions.
- The portability guard changes shape, not strength: the core still reads no env and touches no
  runtime globals; the two start seams are named in the guard, and a layering guard keeps
  `start/` on the public API only.
- Explicit `mode` makes "a human typed it" literal for apps that set it. Inference remains for
  apps that do not, bounded by the fail-closed rule above.
- Cloudflare Workers, the web SDK and the other languages are out of this first step.
