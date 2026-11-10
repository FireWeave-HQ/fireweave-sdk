# ADR-0014: CommonJS twins for the server and web SDKs; ES modules stay the format

- **Status:** Accepted
- **Date:** 2026-11-10
- **Scope:** `sdks/node`, `sdks/web`, `tools/typescript/twins/`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- **Related:** ADR-0008 (multi-runtime support), ADR-0009 (browser control points), ADR-0012 (start profile)

## Context and Problem Statement

`@fireweaveai/server-sdk` and `@fireweaveai/web-sdk` are ES modules only. On Node 20.19+ and
22.12+, `require()` of an ES module works, so a plain CommonJS app can already use them. Measured
on 2026-11-10, these projects still could not:

| Project | What fails with the ESM package |
| --- | --- |
| Jest 29/30 with its default config (CommonJS test files) | `SyntaxError: Unexpected token 'export'` or `Must use import to load ES Module` |
| TypeScript compiling to CommonJS with `module` `node16`/`node18`, or `nodenext` on TypeScript < 5.8 | `TS1479`: the referenced file is an ECMAScript module |
| TypeScript with `moduleResolution` `node10` (NestJS-style `module: commonjs`) | `TS2307` on every subpath (`/start`, `/register`, `/vite`, `/define`) |
| Node 21.x and 22.0–22.11, which `engines` (`>=20.20`) admits | `ERR_REQUIRE_ESM` |
| Vite 5 with a CommonJS-context config loading `/vite` | Vite refuses an ESM-only dependency |

## Considered Options

1. **Rely on `require(esm)` and document it.** No build change. Leaves every row above broken.
2. **One package with both builds** (`import`/`require` export conditions). Fixes the rows, but
   every project that both imports and requires the SDK loads two copies, existing `require()`
   users move to a new copy, and the `exports` change needs a major release.
3. **Separate CommonJS packages** (`-cjs` twins). Fixes the rows; the ESM packages do not
   change; two copies load only in a project that installs both.

## Decision

Option 3. `@fireweaveai/server-sdk-cjs` and `@fireweaveai/web-sdk-cjs` are published beside the
ESM packages:

- **Same source, no source change.** `tools/typescript/twins/build-cjs-twin.mjs` compiles the package's own
  sources with its own tsconfigs, staged under a `"type":"commonjs"` scope, into
  `<pkg>/build/cjs`. The twin's `package.json` is generated from the ESM one: same version,
  `exports`, `engines` and peers, plus `typesVersions` so `node10` resolves the subpaths. No file
  is written for the twin by hand, and nothing in `src/` exists for it.
- **One release.** A twin ships at its ESM package's version, from the same stamped tree, tag
  and publish job. The twin publishes first, so a failed run can be re-run.
- **One gate.** `tools/typescript/twins/verify-twins.sh` (checks T1–T8, `tools/typescript/twins/verify.mjs`) builds and
  packs both packages and fails unless they match: manifest, exported names, the conformance
  suite run against the twin, and the consumers in the table above. It runs in CI (`twins` job),
  in the release `verify` job, and (its dependency-free checks) inside each publish job.
- **Routing.** Which project gets which package is written down once, in
  [Module formats](../module-formats.md), for people and for FireWeave's installers.

## ES modules are the long-term format

The twins are a bridge, not a second product line:

- Nothing is added to a twin that the ESM package lacks, and no other SDK package gets a twin.
- Installers pick the twin only when the project cannot load the ESM package without changing its
  module system or toolchain ([Module formats](../module-formats.md)).
- **Retirement.** In a future major release, when the owner judges that the projects in the table
  above have moved on (for example: every Node version `engines` admits can `require()` an ES
  module, and supported Jest versions load ES modules by default), the twins are retired:
  1. At least one minor release before, the CHANGELOG announces it and each twin's latest
     version is `npm deprecate`d with a message pointing to the ESM package.
  2. The major release stops building and publishing the twins and removes
     `tools/typescript/twins/build-cjs-twin.mjs`, `tools/typescript/twins/` and the `twins` CI job.
  3. Published twin versions stay installable; the ESM packages are unaffected.

## Consequences

- Two npm names per SDK. Each needs one manual first publish and its own Trusted Publisher
  ([RELEASE.md](../../.github/RELEASE.md)).
- A project that loads both packages gets two copies: `start()` state is shared (it lives on
  `globalThis`), but `isFireweaveError` and `instanceof` are false across copies. The routing
  doc says to install one per app, and to install the twin under the ESM name with an npm alias.
- CommonJS cannot be tree-shaken, so browser bundles built from a twin are larger; browser code
  always uses the ESM web package.
- Jest + jsdom needs a one-line `TextEncoder` polyfill, which the twin does not remove; removing
  that need is a source change, outside this decision.
- Browser code keeps the ES module web package even under Jest: Jest maps the name to the web twin
  (`moduleNameMapper`), so the app bundle never contains the twin.
- Every change to `sdks/node` or `sdks/web` must pass the twin gate (`AGENTS.md`).
