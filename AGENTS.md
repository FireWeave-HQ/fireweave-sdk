# Agent instructions — fireweave-sdk

Read [CONTRIBUTING.md](CONTRIBUTING.md) first; this file adds the rules agents most often miss.

## The server and web SDKs ship as two packages each

`sdks/node` publishes `@fireweaveai/server-sdk` (ES module) and `@fireweaveai/server-sdk-cjs`
(CommonJS). `sdks/web` publishes `@fireweaveai/web-sdk` (ES module) and
`@fireweaveai/web-sdk-cjs` (CommonJS). Each twin is built from the same source by
`tools/typescript/twins/build-cjs-twin.mjs`, at the same version
([ADR-0014](docs/adr/0014-commonjs-twin-packages.md)). Which project gets which package:
[docs/module-formats.md](docs/module-formats.md).

Any change under `sdks/node/` or `sdks/web/` (source, `node/`, tsconfigs, `package.json`) ships
in BOTH packages. There is no ESM-only change.

### Before you say a change is done, commit, or open a PR

1. Run the package's own checks: `cd sdks/node && npm run verify`, or
   `cd sdks/web && bun run verify`.
2. Run the twin gate for every package you touched: `tools/typescript/twins/verify-twins.sh node`,
   `tools/typescript/twins/verify-twins.sh web`, or `tools/typescript/twins/verify-twins.sh all`.
3. Paste both results into the PR's Verification section. A red gate blocks the change. Fix
   the code or the build; never weaken, skip or exempt a gate check.

### Rules that keep both packages working

- Never edit `build/cjs/` or write a twin `package.json` by hand. Change the ES module
  `package.json`; the build script derives the twin's manifest from it.
- A new subpath export needs a `types` entry. The gate checks that it exists in both packages
  and that `typesVersions` covers it. Add it to `docs/module-formats.md` if routing changes.
- Do not use what CommonJS output cannot express: top-level `await`, `import.meta`, `export =`,
  or a runtime dependency that is ES-module-only. If a change truly needs one, stop and
  propose an ADR; do not let the packages diverge.
- The packages have zero runtime dependencies. Keep it that way: a dependency would have to work
  under both `import` and `require`.
- State that must be shared when an app loads both packages lives on `globalThis` under a
  `Symbol.for` key, as `src/start/state.ts` does. Do not add new `instanceof` checks on values
  that cross the package boundary.
- The server SDK's browser stubs (`./start`, `./register`) must stay selected for browser builds
  of both packages; gate check T7 enforces this.
- ES modules are the long-term format. Do not add anything only the twins get.

### Releasing

- `release.yml` publishes the twin first, then the ES module package, from the same checkout.
  Never publish one without the other, and never publish from a local machine.
- One CHANGELOG entry covers both packages of an SDK. Name the twin only when a change affects
  CommonJS users alone.
