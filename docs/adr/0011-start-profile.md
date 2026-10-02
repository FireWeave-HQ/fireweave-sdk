# ADR-0011: A start profile for one-line setup, layered on an unchanged core

- **Status:** Proposed (node, web, Python and Go implemented on `feat/server-sdk-start-profile`; needs the cross-language sign-off GOVERNANCE.md requires before other SDKs follow)
- **Date:** 2026-10-02
- **Scope:** `@fireweaveai/server-sdk` (Node, Bun, Deno), `@fireweaveai/web-sdk` (browsers), Python `fireweave.start` and Go `.../sdks/go/v2/fw`. Java, Rust, Swift and Dart adopt the same rules later.
- **Related:** spec/modes.md (core reads no env, mode never inferred), spec/control-points.md (no invented targeting key), ADR-0008 (multi-runtime support), ADR-0009 (browser control points)

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
3. **Default the endpoint from its own release channel.** A staging build defaults to
   `https://staging-app-server.fireweave.ai`, any other to `https://app-server.fireweave.ai`.
   The TypeScript SDKs read a stamp `tools/release/version.sh apply server|web` writes into
   `src/start/build-info.ts` (`-staging.N`). Python and Go need no stamp: Python reads the
   installed distribution's version (staging builds are PEP 440 `X.Y.ZaN`), and Go reads the
   module version from the binary's build info (`vX.Y.Z-staging.N`).
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
- Cloudflare Workers, Java, Rust, Swift and Dart are out of this step.

## The web start profile

`@fireweaveai/web-sdk/start` applies the same rules in the browser, with four differences that
follow from where it runs:

1. **The browser reads no environment** (ADR-0009 rule 3 still holds for shipped code). The key,
   endpoint and environment name are read at **build** time by `@fireweaveai/web-sdk/vite`
   (the `fireweave()` plugin) or `@fireweaveai/web-sdk/define`, which run in Node, apply the same
   policy module the browser uses (`src/start/policy.ts`), and inject the inputs as
   `__FIREWEAVE_WEB_CONFIG__`. Explicit `start()` options still win. A build never infers local
   mode from Vite's `--mode`; only the dev server and Vitest do.
2. **Only browser keys** (`fw_public_…`) are accepted. A server key fails the build with a revoke
   instruction, and the Vite plugin fails a client build whose output contains one.
3. **Nothing throws.** A browser that fails to start must still render, so `start()` never throws
   or rejects: a fault logs once, sets the state to `FAILED` with a `problem`, and reads serve
   defaults. The build is where faults fail loudly.
4. **Identity is the browser's**, not the host's: a persisted `dev_<uuid>` device id (the
   scaffolded harness's key, so migrated apps keep their buckets), `identify`/`reset` for
   sign-in and sign-out, and `persistence`/`setPersistence`/`forget` for consent. There is no
   `instanceKey()`. Remote mode without a DOM (SSR) does nothing, so no identity is shared across
   requests.

Deferred from the web plan: a top-level-await boot redirect with build-target raising, CSP
detection, and a real-bundler integration matrix (Vite 5–8 with Playwright).

## Python and Go

Both follow the server rules above, with idiomatic surfaces (`fireweave.start.start(flags=...)`,
`fw.Start(fw.Options{Flags: ...})`). Their `start()` is synchronous and does no network I/O, so a
read before it cannot be deferred to a later turn the way Node defers it:

- **Python** starts from the environment on that first read, and the first explicit `start()`
  replaces that provisional start once, with a warning. After `os.fork()` the child rebuilds its
  client from the stored config.
- **Go** starts from the environment on that first read, once; a later `Start` with a different
  configuration is an error, as in Node. `fw.Client()` is one permanent client for the process,
  so a pointer captured at package init keeps working across `Start` and `Shutdown`.

Deferred core fixes from the build plan (they change core behaviour, so they are separate work):
Python's input guards, no-redirect transport and extended redaction; Go's remote-adapter
Close/Resolve race (GO-1), extended redaction (GO-RD) and the lower `go` directive (GO-FL).
