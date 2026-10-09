# ADR-0012: A start profile for one-line setup, layered on an unchanged core

- **Status:** Proposed (all eight SDKs implemented on `feat/server-sdk-start-profile`; needs the cross-language sign-off GOVERNANCE.md requires before other SDKs follow)
- **Date:** 2026-10-02
- **Scope:** `@fireweaveai/server-sdk` (Node, Bun, Deno), `@fireweaveai/web-sdk` (browsers), Python `fireweave.start`, Go `.../sdks/go/v3/fw`, Java `ai.fireweave.sdk.start`, Rust `fireweave::start`, Dart `package:fireweave/client.dart` and `server.dart`, and Swift `FireweaveStart`.
- **Spec and conformance:** `spec/start-profile.md` (normative rules SP-1…SP-26) and `contracts/start/` (the shared suite every SDK runs).
- **Related:** spec/modes.md (core reads no env, mode never inferred), spec/control-points.md (no invented targeting key), ADR-0008 (multi-runtime support), ADR-0009 (browser control points), ADR-0011 (Dart control points)

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
   `src/start/build-info.ts` (`-rc.N`). The others need no stamp: Python reads the
   installed distribution's version (staging builds are PEP 440 `X.Y.ZrcN`; any pre-release
   or dev release counts), Go reads the module version from the binary's build info
   (`vX.Y.Z-rc.N`), Java reads a Maven-filtered `build.properties` (`${project.version}`),
   and Rust compiles in `CARGO_PKG_VERSION`. A version is staging when it contains `-rc.`
   (spec SP-13); see "Amendment (2026-10-09): rc spelling".
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
- Cloudflare Workers are out of this step.

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
  replaces that provisional start once, with a warning, then shuts the replaced client down (a
  read racing the swap retries once on the new client). After `os.fork()` the child rebuilds its
  client from the stored config.
- **Go** starts from the environment on that first read, once; a later `Start` with a different
  configuration is an error, as in Node. `fw.Client()` is one permanent client for the process,
  so a pointer captured at package init keeps working across `Start` and `Shutdown`.

Core fixes that landed with this work (2026-10-05): Python refuses HTTP redirects (urllib re-sent
`Authorization` to the redirect target) and degrades bad input types to `InvalidContext`; Go's
remote adapter no longer races `Close` against `Resolve` and owns its own HTTP transport; both
redact by the shared contract (`contracts/errors.json` `rules.redaction`). Still deferred: the lower
`go` directive (GO-FL), until it can be verified on a Go 1.22 toolchain.

## Java and Rust

Both follow Go's shape: `start` is synchronous and does no network I/O, a read before it starts
from the environment once on that read, a different second start is an error, and one permanent
client per process (`Fw.client()`, `fireweave::start::client()`) sits on a forwarding adapter so
a reference captured before `start` keeps working. The instance key uses the same FNV-1a-64 hash
of the host name as Node and Go, so one host gives one key in every SDK.

Java adds `start` as a fourth top-level package beside `application`, `domain` and
`infrastructure`. The architecture guard (`ArchitectureLayersGuardTest`) pins that list, and this
ADR is the decision that admits `start` to it; `StartConfinementGuardTest` keeps it on the public
`application` and `domain` types and keeps every core package from importing it.

Landed (2026-10-05): both redact by the shared contract, both start profiles report a refused,
rate-limited or unreachable fw-server once per kind with `lastErrorKind` (SP-27), and Java adds
`Fw.verify()`, a one-round-trip key check that never throws. Rust's MSRV is 1.85, matching the
locked `ureq` 3 graph. Still deferred: Spring profile support in Java.

## Dart and Swift

Both ship a **client** profile and a **server** profile, because both run in apps and on servers.

- **Client profiles** (Flutter and Dart web; iOS and macOS apps) follow the web profile: browser
  keys only, a device id for anonymous visitors, `identify`/`reset`, and configuration fixed at
  build time — Dart compile-time defines (`--dart-define`, read only as `const` literals, because a
  non-const read is empty under AOT and throws under dart2js) and Swift Info.plist values. They read
  no process environment. A configuration fault never crashes the app (SP-23): it sets the status to
  failed and reads serve defaults. A Swift debug build with no key and no environment name counts as
  development through `FireweaveStart`'s own debug define; a release build fails closed.
- **Server profiles** follow the server rules above: project keys, `FIREWEAVE_*` from the process
  environment, legacy names with a warning, and `instanceKey`.
- **Channel.** Neither can read its own package version at runtime, so `tools/release/version.sh
  apply dart|swift` stamps a build-info file like the TypeScript SDKs. Swift has no manifest and
  releases by tag alone, so a Swift release must commit the stamp before tagging.
- **Lifecycle.** Dart has no side-effect imports or top-level await, so the line is
  `await Fireweave.start(...)`, and the singleton is per isolate. Neither client profile throws, like
  web. The Dart server throws a configuration error before any I/O; the Swift server stops the
  process from `startFireweave(flags:)` (`fatalError`) or throws from
  `try startFireweave(FireweaveStartOptions(...))`, so a deploy without its key never starts.
- **Refresh.** Their cores now keep the last good decisions after a failed re-fetch and report
  `STALE` (spec/control-points.md), and both server profiles re-fetch every 30 s by default
  (`refreshInterval`; zero turns it off). A Dart CLI in remote mode must call `fw.shutdown()` or
  pass a zero interval, or the pending refresh keeps the isolate alive.

Distribution: a Swift release now pushes `sdks/swift` to a mirror repository with a root
`Package.swift` and plain semver tags (`publish-swift-mirror`; the mirror and its deploy key are
company-side provisioning). Java staging builds publish `X.Y.Z-rc.N` to Maven Central.

Deferred: the `fireweave_flutter` companion (persisted device id, build-mode environment, refresh
on resume) and the web real-bundler suite, both waiting for local toolchains; Swift's privacy
manifest and on-device checks. The Swift start profile builds and passes its tests on CI's Linux
Swift legs; it has not run on an Apple device yet.

## Amendment (2026-10-09): rc spelling

From 3.0.0 a staging build is `X.Y.Z-rc.N` in every ecosystem (Python `X.Y.ZrcN`). The
`-staging.N` spelling is retired because Maven ranks an unknown qualifier above the release
(`3.0.0-staging.1 > 3.0.0`), so a staging build on Central would outrank the real release; `rc`
sorts below its own release in SemVer, PEP 440, Maven and Gradle alike.

- **The channel keeps its name.** Only the version suffix changes. The channel enum is public API
  in all eight SDKs, `staging` is stored in customers' project files, and `release.yml`'s `channel`
  input and `release-staging` environment keep their names.
- **`rc` means staging.** In FireWeave SDKs `rc` is a pre-release that calls the staging
  fw-server; no production pre-release exists. A production pre-release, if one is ever needed,
  uses a suffix outside the rule (such as `-beta.N`, which the semver SDKs treat as production).
- **No `-staging.` alias from 3.0.0.** The rule in the semver SDKs is "contains `-rc.`"; `-staging.N`
  is production in new code. Python keeps "any PEP 440 pre-release or dev release is staging".
  Builds published before 3.0.0 keep the rule they shipped with. Side effect, accepted: Go bases a
  pseudo-version on the highest semver ancestor tag, and `sdks/go/v3.0.0-staging.1` outranks every
  rc, so every pseudo-version of `main` is `v3.0.0-staging.1.0.<timestamp>-<sha>` until `v3.0.0` is
  tagged, and calls production, like any untagged development build.
- **Python rc on PyPI.** Python staging builds publish `X.Y.ZrcN` to pypi.org (no longer
  TestPyPI), with the production token, on environment `release`. pip, uv, poetry and pipenv skip
  them unless a requirement names one, so `pip install fireweave` keeps the latest final release.
  `--pre`, a pre-release specifier or uv `--prerelease allow` can still resolve an rc, which calls
  staging, and a PyPI version is permanent. Accepted by the owner on 2026-10-09.
- **Java rc on Maven Central.** Java staging builds publish `X.Y.Z-rc.N` to Central with
  `autoPublish=true` (decision D4, reaffirmed). An rc never outranks its own release, but Maven
  ranges, Gradle dynamic versions and Central's `<latest>`/`<release>` include it, so a Java app
  that resolves a range can get an rc and call staging. The version is permanent. Accepted by the
  owner on 2026-10-09; production apps write an exact plain version.
- **Swift is out of rc cuts** until the Swift mirror and its deploy key exist: `release.yml`'s
  `all` omits swift and a staging `component=swift` is refused. The Swift rule changed with the
  others, so the code is ready when the mirror is.
- **The ordering trap.** SemVer sorts `3.0.0-staging.1` above every `3.0.0-rc.N`. npm
  `3.0.0-staging.1` is deprecated after rc.1 publishes and staging installs pin the exact rc; the
  Go proxy keeps `v3.0.0-staging.1` as `@latest` until `v3.0.0`, whose `go.mod` retracts it.
- **One publish path.** The tag-push triggers of `publish-java.yml` (`java/v*`) and
  `publish-python.yml` (`python/v*`) are retired; `release.yml` dispatch is the routine publish
  path, and both workflows remain dispatch-only manual recovery for a plain version.
- **Release commits.** Rust and Dart staging builds are consumed by git tag, and Swift releases by
  tag alone, so those three tags point at a detached release commit carrying the applied version
  and stamp (`version.sh release-commit`), not at the unstamped checkout. `rust/v3.0.0-staging.1`
  and `dart/v3.0.0-staging.1` predate this and call production.
