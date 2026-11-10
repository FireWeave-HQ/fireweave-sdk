#!/usr/bin/env node
// Build the CommonJS twin of an ESM SDK package (ADR-0014).
//
//   node tools/typescript/twins/build-cjs-twin.mjs <pkgDir> <tsconfig>[:<outSubdir>] ...
//   node tools/typescript/twins/build-cjs-twin.mjs sdks/node tsconfig.json
//   node tools/typescript/twins/build-cjs-twin.mjs sdks/web tsconfig.json tsconfig.node.json:build
//
// Writes <pkgDir>/build/cjs: a complete, packable package named <name>-cjs, at
// the ESM package's version, compiled from the same sources. Nothing under
// <pkgDir> outside build/ is written. Run it after the package's own build, so
// node_modules (tsc) and the version stamp are in place.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [pkgArg, ...projects] = process.argv.slice(2);
if (!pkgArg || projects.length === 0) {
  console.error('usage: node tools/typescript/twins/build-cjs-twin.mjs <pkgDir> <tsconfig>[:<outSubdir>] ...');
  process.exit(2);
}
const pkgDir = resolve(pkgArg);
const build = join(pkgDir, 'build');
const stage = join(build, 'stage');
const out = join(build, 'cjs');
rmSync(stage, { recursive: true, force: true });
rmSync(out, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// 1. Stage the sources under a "type":"commonjs" scope. With module NodeNext, tsc
//    picks each file's output format from its package scope, so the package's own
//    tsconfigs emit CommonJS (and CommonJS .d.ts) here, keep real import() calls,
//    and work on TypeScript 5.x and 6.x alike.
for (const entry of ['src', 'node', 'tsconfig.base.json', 'tsconfig.json', 'tsconfig.node.json']) {
  if (existsSync(join(pkgDir, entry))) cpSync(join(pkgDir, entry), join(stage, entry), { recursive: true });
}
writeFileSync(join(stage, 'package.json'), '{"type":"commonjs"}\n');
symlinkSync(join(pkgDir, 'node_modules'), join(stage, 'node_modules'));

// 2. Compile each project into the same dist layout the ESM build uses.
for (const spec of projects) {
  const [tsconfig, sub = ''] = spec.split(':');
  execFileSync(join(pkgDir, 'node_modules', '.bin', 'tsc'), [
    '-p', join(stage, tsconfig),
    '--outDir', join(out, 'dist', sub),
    '--verbatimModuleSyntax', 'false', // TS1287/TS1295: CommonJS output needs import elision
    '--declarationMap', 'false',
    '--sourceMap', 'false',
  ], { stdio: 'inherit' });
}

// 3. Derive the manifest from the ESM one, so the two cannot drift.
const esm = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
// The SDKs have zero runtime dependencies (AGENTS.md); a dependency would also
// have to load under both import and require. Refuse rather than drop it.
for (const field of ['dependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies']) {
  if (esm[field] && Object.keys(esm[field]).length) {
    console.error(`build-cjs-twin: ${esm.name} declares ${field}; the SDKs must have none (ADR-0014, AGENTS.md).`);
    process.exit(1);
  }
}
const typesVersions = { '*': {} };
for (const [subpath, target] of Object.entries(esm.exports)) {
  if (subpath !== '.') typesVersions['*'][subpath.slice(2)] = [target.types]; // node10 ignores "exports"
}
const pick = (...keys) => Object.fromEntries(keys.filter((k) => esm[k] !== undefined).map((k) => [k, esm[k]]));
const manifest = {
  name: `${esm.name}-cjs`,
  version: esm.version,
  description: `CommonJS build of ${esm.name}, for require() and toolchains without ESM support. ${esm.description}`,
  ...pick('license', 'engines', 'repository', 'homepage', 'bugs', 'sideEffects'),
  type: 'commonjs',
  ...pick('main', 'types'),
  typesVersions,
  exports: esm.exports,
  files: ['dist'],
  ...pick('peerDependencies', 'peerDependenciesMeta', 'keywords'),
};
writeFileSync(join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// 4. README (with a note saying which package this is) and LICENSE.
const note =
  `> **This is the CommonJS build of [\`${esm.name}\`](https://www.npmjs.com/package/${esm.name}).**\n` +
  `> Use it only when your project cannot load ES modules (see\n` +
  `> [Module formats](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/docs/module-formats.md)).\n` +
  `> Same code, same version, same import paths. ES modules are the long-term format;\n` +
  `> this package will be retired in a future major release.\n\n`;
writeFileSync(join(out, 'README.md'), note + readFileSync(join(pkgDir, 'README.md'), 'utf8'));
const license = [join(pkgDir, 'LICENSE'), join(pkgDir, '..', '..', 'LICENSE')].find((f) => existsSync(f));
if (license) cpSync(license, join(out, 'LICENSE'));

rmSync(stage, { recursive: true, force: true });
console.log(`built ${manifest.name}@${manifest.version} -> ${out}`);
