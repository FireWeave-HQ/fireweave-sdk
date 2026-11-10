#!/usr/bin/env node
// The twin gate (ADR-0014, docs/module-formats.md).
//
//   node tools/typescript/twins/verify.mjs [node|web|all] [--publish]   (or tools/typescript/twins/verify-twins.sh)
//
// Builds each ESM SDK package and its CommonJS twin from the working tree, packs
// both, installs the tarballs into a scratch project under tools/typescript/twins/.work/,
// and checks that the two packages match and that the twin works for the
// consumers it exists for. Exit 1 if any check fails. Nothing outside build/
// and tools/typescript/twins/.work/ is written.
//
// --publish runs only the checks that need no third-party tools (T1, T8, T2,
// T3, the T4 smoke). release.yml uses it inside the publish jobs, which hold
// an npm OIDC token and so must not install the gate's dev tools; the full
// gate has already passed in the release's unprivileged verify job.
//
//   T1 build      ESM build and twin build both succeed
//   T2 manifest   twin = ESM name + "-cjs"; same version, exports, engines, peers;
//                 every exports target is in both tarballs; typesVersions covers
//                 every subpath
//   T3 surface    import() of each ESM subpath and require() of the twin's export
//                 the same names
//   T4 behaviour  CommonJS smoke test; the package's conformance suite run
//                 against the twin
//   T5 consumers  ESM import of the twin; Jest (node, and jsdom with the
//                 documented polyfill); TypeScript node16 / nodenext / node10;
//                 Bun and Deno when installed
//   T6 types      attw: ESM package esm-only profile, twin all profiles
//   T7 browser    server ./start and ./register bundle to their browser stubs
//                 from both packages
//   T8 pack       npm pack works; the twin ships only dist/, package.json,
//                 README.md, LICENSE; the ESM package ships no build/ file
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const BIN = join(HERE, 'node_modules', '.bin');
const WORK = join(HERE, '.work');

const PACKAGES = {
  node: {
    dir: join(ROOT, 'sdks', 'node'),
    fixtures: 'server',
    build: ['npm', ['run', 'build']],
    twin: ['tsconfig.json'],
    conformance: (pkgDir) => [join(pkgDir, 'node_modules', '.bin', 'tsx'), []],
    lib: 'es2022',
    browserStubs: true,
  },
  web: {
    dir: join(ROOT, 'sdks', 'web'),
    fixtures: 'web',
    build: ['bun', ['run', 'build']],
    twin: ['tsconfig.json', 'tsconfig.node.json:build'],
    conformance: () => ['bun', []],
    lib: 'es2022,dom',
    browserStubs: false,
  },
};

const args = process.argv.slice(2);
const publishMode = args.includes('--publish');
const target = args.find((a) => !a.startsWith('--')) ?? 'all';
const keys = target === 'all' ? Object.keys(PACKAGES) : [target];
if (!keys.every((k) => k in PACKAGES)) {
  console.error('usage: node tools/typescript/twins/verify.mjs [node|web|all] [--publish]');
  process.exit(2);
}
if (!publishMode && !existsSync(BIN)) {
  console.error('tools/typescript/twins has no node_modules: run `npm ci` in tools/typescript/twins (tools/typescript/twins/verify-twins.sh does).');
  process.exit(2);
}

const has = (cmd) => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;

/** Run a command; throw with the tail of its output when it exits non-zero. */
function run(cmd, args, { cwd, env } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300_000,
  });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0) {
    const tail = output.trim().split('\n').slice(-25).join('\n');
    throw new Error(`\`${[cmd, ...args].join(' ')}\` exited ${r.status ?? r.signal ?? r.error}\n${tail}`);
  }
  return output;
}

const lastLine = (s) => s.trim().split('\n').at(-1) ?? '';
const expectOk = (out, what) => {
  if (lastLine(out) !== 'ok') throw new Error(`${what} did not print ok:\n${out.trim().split('\n').slice(-10).join('\n')}`);
};

/** Leaf paths of an "exports" map. */
const exportTargets = (exp) =>
  Object.values(exp).flatMap((v) => (typeof v === 'string' ? [v] : exportTargets(v)));

const results = [];

/** A check that could not run here. It fails the gate when CI is set. */
class Skip {
  constructor(reason) {
    this.reason = reason;
  }
}

async function verify(key) {
  const p = PACKAGES[key];
  const work = join(WORK, key);
  const sandbox = join(work, 'sandbox');
  const packs = join(work, 'packs');
  const check = (id, title, fn) => {
    const started = Date.now();
    try {
      const note = fn();
      if (note instanceof Skip) {
        results.push({ key, id, title, ok: !process.env.CI, skipped: true, note: note.reason, ms: Date.now() - started });
        return true;
      }
      results.push({ key, id, title, ok: true, note: note ?? '', ms: Date.now() - started });
      return true;
    } catch (e) {
      results.push({ key, id, title, ok: false, note: e.message, ms: Date.now() - started });
      return false;
    }
  };

  // T1 build
  if (!check('T1', 'build', () => {
    run(p.build[0], p.build[1], { cwd: p.dir });
    run(process.execPath, [join(HERE, 'build-cjs-twin.mjs'), p.dir, ...p.twin], { cwd: ROOT });
  })) return;

  const esm = JSON.parse(readFileSync(join(p.dir, 'package.json'), 'utf8'));
  const twinName = `${esm.name}-cjs`;
  const modulesDir = join(sandbox, 'node_modules');
  const esmDir = join(modulesDir, ...esm.name.split('/'));
  const twinDir = join(modulesDir, ...twinName.split('/'));
  const tarballs = {};

  // T8 pack — first, because every later check runs against the installed tarballs.
  if (!check('T8', 'pack', () => {
    rmSync(work, { recursive: true, force: true });
    mkdirSync(packs, { recursive: true });
    for (const [which, dir] of [['esm', p.dir], ['twin', join(p.dir, 'build', 'cjs')]]) {
      const [info] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', packs], { cwd: dir }));
      tarballs[which] = join(packs, info.filename);
      const files = info.files.map((f) => f.path);
      if (which === 'twin') {
        const extra = files.filter((f) => !f.startsWith('dist/') && !['package.json', 'README.md', 'LICENSE'].includes(f));
        if (extra.length) throw new Error(`twin tarball ships unexpected files: ${extra.join(', ')}`);
      } else if (files.some((f) => f.startsWith('build/'))) {
        throw new Error('ESM tarball ships files from build/');
      }
    }
    for (const [which, dest] of [['esm', esmDir], ['twin', twinDir]]) {
      mkdirSync(dest, { recursive: true });
      run('tar', ['-xzf', tarballs[which], '-C', dest, '--strip-components=1']);
    }
    writeFileSync(join(sandbox, 'package.json'), '{ "private": true, "type": "commonjs" }\n');
    cpSync(join(HERE, 'fixtures', p.fixtures), sandbox, { recursive: true });
    cpSync(join(HERE, 'fixtures', 'jest-setup.cjs'), join(sandbox, 'jest-setup.cjs'));
    return `${Object.values(tarballs).map((t) => t.split('/').at(-1)).join(', ')}`;
  })) return;

  // T2 manifest parity
  check('T2', 'manifest parity', () => {
    const a = JSON.parse(readFileSync(join(esmDir, 'package.json'), 'utf8'));
    const b = JSON.parse(readFileSync(join(twinDir, 'package.json'), 'utf8'));
    const errors = [];
    if (b.name !== twinName) errors.push(`twin name ${b.name}, expected ${twinName}`);
    if (b.type !== 'commonjs') errors.push(`twin type ${b.type}`);
    for (const field of ['version', 'exports', 'engines', 'sideEffects', 'peerDependencies', 'peerDependenciesMeta', 'main', 'types', 'license', 'dependencies', 'optionalDependencies']) {
      if (!isDeepStrictEqual(a[field], b[field])) errors.push(`${field} differs`);
    }
    for (const t of exportTargets(a.exports)) {
      if (!existsSync(join(esmDir, t))) errors.push(`ESM tarball is missing ${t}`);
      if (!existsSync(join(twinDir, t))) errors.push(`twin tarball is missing ${t}`);
    }
    const subpaths = Object.keys(a.exports).filter((s) => s !== '.').map((s) => s.slice(2)).sort();
    const tv = b.typesVersions?.['*'] ?? {};
    if (!isDeepStrictEqual(Object.keys(tv).sort(), subpaths)) errors.push(`typesVersions covers ${Object.keys(tv)} not ${subpaths}`);
    for (const [sub, [path]] of Object.entries(tv)) if (!existsSync(join(twinDir, path))) errors.push(`typesVersions ${sub} -> missing ${path}`);
    if (errors.length) throw new Error(errors.join('\n'));
    return `${a.name}@${a.version} / ${b.name}@${b.version}`;
  });

  // T3 surface parity
  const env = { NODE_ENV: 'test', FIREWEAVE_ENV: 'local' };
  check('T3', 'surface parity', () => {
    const subpaths = Object.keys(esm.exports);
    const script = [
      "import { createRequire } from 'node:module';",
      'const require = createRequire(import.meta.url);',
      `const subpaths = ${JSON.stringify(subpaths)};`,
      'const out = {};',
      'for (const s of subpaths) {',
      `  const esm = Object.keys(await import(${JSON.stringify(esm.name)} + s.slice(1))).filter((k) => k !== 'default').sort();`,
      `  const cjs = Object.keys(require(${JSON.stringify(twinName)} + s.slice(1))).filter((k) => k !== 'default' && k !== '__esModule').sort();`,
      '  out[s] = { esm, cjs };',
      '}',
      'console.log(JSON.stringify(out));',
      'process.exit(0);',
    ].join('\n');
    writeFileSync(join(sandbox, 'surface.mjs'), script);
    const surface = JSON.parse(lastLine(run(process.execPath, ['surface.mjs'], { cwd: sandbox, env })));
    const diffs = Object.entries(surface)
      .filter(([, v]) => !isDeepStrictEqual(v.esm, v.cjs))
      .map(([s, v]) => `${s}: ESM-only [${v.esm.filter((k) => !v.cjs.includes(k))}] twin-only [${v.cjs.filter((k) => !v.esm.includes(k))}]`);
    if (diffs.length) throw new Error(diffs.join('\n'));
    return Object.entries(surface).map(([s, v]) => `${s} ${v.esm.length}`).join(', ');
  });

  // T4 behaviour parity
  check('T4', 'behaviour: CommonJS smoke', () => {
    expectOk(run(process.execPath, ['smoke.cjs'], { cwd: sandbox, env: { NODE_ENV: 'test' } }), 'smoke.cjs');
    if (key === 'node') {
      expectOk(
        run(process.execPath, ['-r', `${twinName}/register`, 'register.cjs'], { cwd: sandbox, env: { FIREWEAVE_ENV: 'local' } }),
        'register preload',
      );
    }
  });
  if (publishMode) return;

  check('T4', 'behaviour: conformance suite against the twin', () => {
    // The runner imports the SDK by its ESM name and finds contracts/ and
    // test-server/ four levels up, so mirror that layout with the ESM name
    // aliased to the twin (exactly what an npm alias install gives a user).
    const mirror = join(work, 'conformance');
    const rel = join('sdks', key, 'test', 'conformance');
    mkdirSync(join(mirror, rel), { recursive: true });
    cpSync(join(p.dir, 'test', 'conformance', 'run.ts'), join(mirror, rel, 'run.ts'));
    for (const d of ['contracts', 'test-server']) symlinkSync(join(ROOT, d), join(mirror, d));
    mkdirSync(join(mirror, 'node_modules', ...esm.name.split('/').slice(0, -1)), { recursive: true });
    symlinkSync(twinDir, join(mirror, 'node_modules', ...esm.name.split('/')));
    writeFileSync(join(mirror, 'package.json'), '{ "private": true, "type": "module" }\n');
    const [cmd, args] = p.conformance(p.dir);
    const out = run(cmd, [...args, join(mirror, rel, 'run.ts')], { cwd: join(mirror, 'sdks', key) });
    return out.trim().split('\n').filter((l) => /pass|fail/i.test(l)).slice(-1)[0] ?? '';
  });

  // T5 consumers
  check('T5', 'consumers: ESM import of the twin', () => {
    expectOk(run(process.execPath, ['esm-import.mjs'], { cwd: sandbox, env: { NODE_ENV: 'test' } }), 'esm-import.mjs');
  });
  for (const [runtime, args] of [['bun', []], ['deno', ['run', '-A']]]) {
    check('T5', `consumers: require() on ${runtime}`, () => {
      if (!has(runtime)) return new Skip(`${runtime} is not installed`);
      expectOk(run(runtime, [...args, 'smoke.cjs'], { cwd: sandbox, env: { NODE_ENV: 'test' } }), `${runtime} smoke.cjs`);
    });
  }
  check('T5', 'consumers: Jest default config (node; jsdom with the polyfill)', () => {
    // The Jest route (docs/module-formats.md): code keeps the ES module name and
    // Jest maps it to the twin, so the fixtures require the ES module name.
    const config = {
      rootDir: sandbox,
      testMatch: ['<rootDir>/jest/*.test.js'],
      setupFiles: ['<rootDir>/jest-setup.cjs'],
      moduleNameMapper: { [`^${esm.name}(/.*)?$`]: `${twinName}$1` },
    };
    const out = run(join(BIN, 'jest'), ['--ci', '--config', JSON.stringify(config)], { cwd: sandbox });
    return out.match(/Tests:.*$/m)?.[0] ?? '';
  });
  for (const [label, file, mod, res] of [
    ['node16', 'consumer.cts', 'node16', 'node16'],
    ['nodenext', 'consumer.cts', 'nodenext', 'nodenext'],
    ['commonjs + node10', 'consumer-node10.ts', 'commonjs', 'node10'],
  ]) {
    check('T5', `consumers: TypeScript ${label}`, () => {
      run(join(BIN, 'tsc'), [
        '--noEmit', '--strict', '--skipLibCheck', 'false', '--target', 'es2022', '--lib', p.lib,
        '--types', 'node', '--module', mod, '--moduleResolution', res, file,
      ], { cwd: sandbox });
    });
  }

  // T6 types
  check('T6', 'types (attw)', () => {
    run(join(BIN, 'attw'), [tarballs.esm, '--profile', 'esm-only', '--format', 'ascii']);
    run(join(BIN, 'attw'), [tarballs.twin, '--format', 'ascii']);
  });

  // T7 browser stubs
  if (p.browserStubs) {
    check('T7', 'browser stubs from both packages', () => {
      writeFileSync(join(sandbox, 'browser-esm.mjs'), `import '${esm.name}/start';\nimport '${esm.name}/register';\n`);
      writeFileSync(join(sandbox, 'browser-cjs.cjs'), `require('${twinName}/start');\nrequire('${twinName}/register');\n`);
      const problems = [];
      for (const entry of ['browser-esm.mjs', 'browser-cjs.cjs']) {
        const meta = join(sandbox, `${entry}.meta.json`);
        run(join(BIN, 'esbuild'), [entry, '--bundle', '--platform=browser', `--metafile=${meta}`, `--outfile=${join(sandbox, `${entry}.out.js`)}`], { cwd: sandbox });
        const inputs = Object.keys(JSON.parse(readFileSync(meta, 'utf8')).inputs);
        for (const stub of ['dist/start/browser.js', 'dist/register-browser.js']) {
          if (!inputs.some((i) => i.endsWith(stub))) problems.push(`${entry}: ${stub} not used`);
        }
        for (const server of ['dist/start/index.js', 'dist/register.js']) {
          if (inputs.some((i) => i.endsWith(server))) problems.push(`${entry}: server file ${server} reached the browser bundle`);
        }
      }
      if (problems.length) throw new Error(problems.join('\n'));
    });
  }
}

for (const key of keys) await verify(key);

console.log(`\nTwin gate (ADR-0014)${publishMode ? ', publish checks' : ''}`);
for (const r of results) {
  const status = r.skipped ? (r.ok ? 'SKIP' : 'FAIL') : r.ok ? 'PASS' : 'FAIL';
  console.log(`  ${status}  ${r.key.padEnd(4)} ${r.id}  ${r.title}${r.note && r.ok ? `  (${r.note})` : ''}`);
  if (r.skipped && !r.ok) console.log(`          ${r.note}; CI must run every check`);
  else if (!r.ok) console.log(r.note.split('\n').map((l) => `          ${l}`).join('\n'));
}
const failed = results.filter((r) => !r.ok).length;
const ran = new Set(results.map((r) => r.key));
const missing = keys.filter((k) => !ran.has(k));
if (failed || missing.length) {
  console.log(`\n${failed} check(s) failed. Neither package of a failing SDK may be published.`);
  process.exit(1);
}
const skipped = results.filter((r) => r.skipped).length;
console.log(`\n${results.length - skipped} checks passed${skipped ? `, ${skipped} skipped (not installed here; CI runs them)` : ''} for ${keys.join(', ')}.`);
