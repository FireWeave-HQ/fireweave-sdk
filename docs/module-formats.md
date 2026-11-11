# Module formats: which package to install

Install the ES module package. Add a CommonJS twin only in the cases below. This page is the routing rule for people and for FireWeave's installers: the local `initialise` skill and the cloud setup are to pick packages by it.

| SDK | ES module package (default) | CommonJS twin |
| --- | --- | --- |
| Server (Node, Bun, Deno) | `@fireweaveai/server-sdk` | `@fireweaveai/server-sdk-cjs` |
| Browser | `@fireweaveai/web-sdk` | `@fireweaveai/web-sdk-cjs` |

A twin is built from the same source at the same version, with the same import paths ([ADR-0014](adr/0014-commonjs-twin-packages.md)). The twins are published from the first release that includes ADR-0014. ES modules are the long-term format: the twins will be retired in a future major release, so prefer the ES module package whenever the project can load it.

## Route a project

Route each app separately: in a monorepo, each workspace package that uses the SDK, not the repo root. Check the rows in order; the first match decides.

| # | The project | Install |
| --- | --- | --- |
| 1 | Server code on an edge or worker runtime: `wrangler.toml` / `wrangler.json(c)`, or `export const runtime = 'edge'` | `@fireweaveai/server-sdk`, plus an alias of `@fireweaveai/server-sdk/start` to its `dist/start/index.js` ([why](#settings-for-other-toolchains)). Never the twin: it fails the same way |
| 2 | A full-stack framework: `next`, `@sveltejs/kit`, `nuxt`, `@react-router/dev`, `@remix-run/*`, `astro` or `@angular/ssr` in dependencies | `@fireweaveai/server-sdk` for server code and `@fireweaveai/web-sdk` for client code. The framework bundles both. If [Jest runs as CommonJS](#twin-triggers), [map Jest to the twins](#tested-with-jest). |
| 3 | Other browser code: anything a bundler builds for the browser (client entry, `index.html`) | `@fireweaveai/web-sdk`. If [Jest runs as CommonJS](#twin-triggers), [map Jest to the web twin](#tested-with-jest). If a [build config is CommonJS](#a-build-config-that-node-loads-as-commonjs), fix the config. |
| 4 | Bun: `bun.lock`, `bun.lockb`, `bunfig.toml`, or `"packageManager": "bun@…"` | `@fireweaveai/server-sdk` |
| 5 | Deno: `deno.json`, `deno.jsonc` or `deno.lock` | `@fireweaveai/server-sdk` via `npm:` specifiers. If the project has `.cjs` files or `require()`, also set `"nodeModulesDir": "auto"` |
| 6 | Node server code where Jest is the only [twin trigger](#twin-triggers) | `@fireweaveai/server-sdk`, and [map Jest to the twin](#tested-with-jest) |
| 7 | Node server code that matches any other [twin trigger](#twin-triggers), whether or not production code is bundled (the triggers concern the typechecker and the Node version) | `@fireweaveai/server-sdk-cjs`, [installed under the ES module name](#install-the-server-twin) |
| 8 | Any other Node server code: ES modules (`"type": "module"`, `.mjs`/`.mts` entries), bundled code (esbuild, webpack, `serverless-esbuild`, AWS CDK `NodejsFunction`), or plain `require()` | `@fireweaveai/server-sdk` |

`tsx` runs CommonJS and ES modules alike, so it says nothing about the module format; read `"type"` and the file extensions instead.

## Twin triggers

A project needs a twin when any of these holds:

| Trigger | How to detect it | What fails with the ES module package |
| --- | --- | --- |
| Jest runs the tests as CommonJS | `jest` in dependencies, a `jest.config.*`, or a `"jest"` key in `package.json`; and no `--experimental-vm-modules` in the test script | `Unexpected token 'export'` / `Must use import to load ES Module` |
| TypeScript resolves like `node10` | `compilerOptions.module` is `commonjs` with `moduleResolution` unset, `node` or `node10` (the NestJS 10 starter) | `TS2307` on `@fireweaveai/server-sdk/start` |
| TypeScript `node16`/`node18` in a CommonJS package | `module` is `node16` or `node18`, and `package.json` has no `"type": "module"` | `TS1479` |
| TypeScript `nodenext` before 5.8, in a CommonJS package | `module` is `nodenext`, TypeScript < 5.8, no `"type": "module"` | `TS1479` |
| A Node version without `require()` of ES modules | `engines.node`, `.nvmrc`, `.node-version`, a Dockerfile `FROM node:…` or CI admits Node 21.x or 22.0–22.11 | `ERR_REQUIRE_ESM` |

For browser code and full-stack frameworks, only the Jest trigger matters. When the Node version is unknown, assume a current LTS.

## Install the server twin

Install it under the ES module package's name, so imports, templates and agent instructions stay `@fireweaveai/server-sdk/start`:

```bash
npm install @fireweaveai/server-sdk@npm:@fireweaveai/server-sdk-cjs@<version>
pnpm add @fireweaveai/server-sdk@npm:@fireweaveai/server-sdk-cjs@<version>
yarn add @fireweaveai/server-sdk@npm:@fireweaveai/server-sdk-cjs@<version>
```

`package.json` then records `"@fireweaveai/server-sdk": "npm:@fireweaveai/server-sdk-cjs@^<version>"`, and the code is the same as with the ES module package:

```js
const { start, fw } = require('@fireweaveai/server-sdk/start');
```

## Tested with Jest

The app keeps the ES module packages; Jest loads the twins under the same names. Add each twin the project's code uses as a devDependency, at the same version as its ES module package, and map it:

```bash
npm install --save-dev @fireweaveai/server-sdk-cjs@<version>   # server code
npm install --save-dev @fireweaveai/web-sdk-cjs@<version>      # browser code
```

```js
// jest.config.js
module.exports = {
  moduleNameMapper: {
    '^@fireweaveai/server-sdk(/.*)?$': '@fireweaveai/server-sdk-cjs$1',
    '^@fireweaveai/web-sdk(/.*)?$': '@fireweaveai/web-sdk-cjs$1',
  },
  // with testEnvironment 'jsdom' only: a file containing
  //   globalThis.TextEncoder ??= require('node:util').TextEncoder;
  setupFiles: ['<rootDir>/jest.setup.js'],
};
```

Never alias the web twin over the ES module name in `dependencies`: browser bundles would grow by about a third and the Vite plugin's dependency settings would no longer match.

## A build config that Node loads as CommonJS

Vite 5 refuses `@fireweaveai/web-sdk/vite` from a config it loads as CommonJS: `vite.config.cjs` or `.cts`, or `vite.config.js` or `.ts` in a package without `"type": "module"`. Rename the config to `vite.config.mjs` (`vite.config.mts` for TypeScript). Vite 6 and later need no change.

Any other CommonJS build config that loads `@fireweaveai/web-sdk/define` (a `next.config.js` without `"type": "module"`, for example) works on Node 20.20+ and 22.12+. On a Node version that cannot `require()` an ES module, rename it to `.mjs`.

If renaming is not possible, add `@fireweaveai/web-sdk-cjs` as a devDependency and use it in the config only (`require('@fireweaveai/web-sdk-cjs/vite')` or `/define`).

Two older bundlers need the web twin for the app itself, because they ignore `"exports"`: webpack 4 (Create React App 4 and older, `webpack-cli` 3), with `resolve.alias` for each subpath, and Browserify, with deep paths (`@fireweaveai/web-sdk-cjs/dist/start/index.js`).

## Rules for installers

- **One package per app for server code.** Never install both. Two copies share `start()` state, but an error from one fails `isFireweaveError` in the other, and npm cannot keep two names on one version.
- **Same version.** A twin version always matches the ES module package version; install by version or range, never a bare twin name.
- **Reading the installed version.** In an aliased install, `node_modules/@fireweaveai/server-sdk/package.json` says `"name": "@fireweaveai/server-sdk-cjs"`. Accept either name.
- **Moving to ES modules later** is a dependency change only: replace the alias with `"@fireweaveai/server-sdk": "^<version>"`, or drop the Jest mapping. No code changes.
- **Never the web twin in a Vite-based app's dependencies** (SvelteKit, Nuxt, React Router, Astro): the `fireweave()` plugin excludes `@fireweaveai/web-sdk` from Vite's pre-bundling, so `vite dev` breaks.

## Settings for other toolchains

These are not reasons to pick a twin; tell the user, or write the setting:

| Toolchain | Setting |
| --- | --- |
| Jest with `testEnvironment: 'jsdom'` | jsdom has no `TextEncoder`, which the SDK needs when it loads: add `globalThis.TextEncoder ??= require('node:util').TextEncoder;` to a `setupFiles` file |
| Rollup with `@rollup/plugin-node-resolve` | `nodeResolve({ browser: true })` for browser builds, or the server `start` code is bundled instead of its browser stub |
| Parcel 2 | `"@parcel/resolver-default": { "packageExports": true }` in the root `package.json` |
| Cloudflare Workers, Next.js edge routes | these runtimes resolve the server package to its browser stub. Alias `@fireweaveai/server-sdk/start` (and `/register`) to `dist/start/index.js` (`dist/register.js`): `alias` in the wrangler config, `turbopack.resolveAlias` or an edge-only webpack `resolve.alias` in Next. The twin does not change this |

## For SDK contributors

Every change to `sdks/node` or `sdks/web` ships in both packages. Run `tools/typescript/twins/verify-twins.sh` before calling a change done; see [AGENTS.md](../AGENTS.md).
