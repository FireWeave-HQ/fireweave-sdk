/**
 * Build helpers for the web start profile: the fireweave() Vite plugin and
 * fireweaveDefine()/assertFireweaveBuild(), driven through their hooks with a
 * fake env-file loader. They run in Node at config time.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createFireweavePlugin } from '@fireweaveai/web-sdk/vite';
import { assertFireweaveBuild, fireweaveDefine } from '@fireweaveai/web-sdk/define';

const BROWSER_KEY = 'fw_public_build_abc123';

function plugin(env: Record<string, string | undefined> = {}, files: Record<string, string> = {}, options = {}) {
  const lines: string[] = [];
  const loads: Array<{ mode: string; envDir: string; prefixes: string[] }> = [];
  const p = createFireweavePlugin(options, {
    env,
    log: (line) => void lines.push(line),
    loadEnv: (mode, envDir, prefixes) => {
      loads.push({ mode, envDir, prefixes });
      return files;
    },
  });
  return { p, lines, loads };
}

const injected = (result: Record<string, unknown> | undefined): Record<string, unknown> => {
  const define = result?.['define'] as Record<string, string>;
  return JSON.parse(define['__FIREWEAVE_WEB_CONFIG__'] ?? 'null') as Record<string, unknown>;
};

describe('fireweave() Vite plugin: config', () => {
  it('dev server without a key is local from the Vite mode', async () => {
    const { p, lines } = plugin();
    const config = injected(await p.config({}, { command: 'serve', mode: 'development' }));
    assert.equal(config['environment'], 'development');
    assert.equal(config['key'], undefined);
    assert.ok(lines.some((l) => l.startsWith('[fireweave] local mode')));
  });

  it('Vitest (serve, mode test) is local too', async () => {
    const { p } = plugin();
    const config = injected(await p.config({}, { command: 'serve', mode: 'test' }));
    assert.equal(config['environment'], 'test');
  });

  it('a build never infers local from --mode development', async () => {
    const { p } = plugin();
    await assert.rejects(() => p.config({}, { command: 'build', mode: 'development' }), /FIREWEAVE_BROWSER_KEY is not set/);
  });

  it('a build with FIREWEAVE_ENV=test and no key is local', async () => {
    const { p } = plugin({ FIREWEAVE_ENV: 'test' });
    const config = injected(await p.config({}, { command: 'build', mode: 'production' }));
    assert.equal(config['environmentSource'], 'FIREWEAVE_ENV');
  });

  it('a build with the browser key injects it with its source', async () => {
    const { p, lines } = plugin({ FIREWEAVE_BROWSER_KEY: BROWSER_KEY });
    const config = injected(await p.config({}, { command: 'build', mode: 'production' }));
    assert.equal(config['key'], BROWSER_KEY);
    assert.equal(config['keySource'], 'FIREWEAVE_BROWSER_KEY');
    assert.ok(lines.some((l) => l.includes('remote mode: browser key from FIREWEAVE_BROWSER_KEY, fw-server app-server.fireweave.ai')));
    assert.ok(lines.every((l) => !l.includes(BROWSER_KEY)), 'no line prints the key');
  });

  it('reads Vite env files from the resolved root and envDir, process env first', async () => {
    const { p, loads } = plugin({}, { FIREWEAVE_BROWSER_KEY: BROWSER_KEY });
    const config = injected(await p.config({ root: 'apps/web', envDir: './env' }, { command: 'build', mode: 'production' }));
    assert.equal(loads[0]?.envDir, resolve('apps/web', './env'));
    assert.equal(config['keySource'], 'FIREWEAVE_BROWSER_KEY (.env files)');
    const both = plugin({ FIREWEAVE_BROWSER_KEY: 'fw_public_process' }, { FIREWEAVE_BROWSER_KEY: BROWSER_KEY });
    assert.equal(injected(await both.p.config({}, { command: 'build', mode: 'production' }))['key'], 'fw_public_process');
  });

  it('envDir false reads no files', async () => {
    const { p, loads } = plugin({ FIREWEAVE_ENV: 'development' });
    await p.config({ envDir: false }, { command: 'serve', mode: 'development' });
    assert.equal(loads.length, 0);
  });

  it('a server key fails the build without printing it', async () => {
    const { p } = plugin({ FIREWEAVE_BROWSER_KEY: 'project-api-key_supersecret1' });
    await assert.rejects(
      () => p.config({}, { command: 'build', mode: 'production' }),
      (err: Error) => /server key/.test(err.message) && /revoke/.test(err.message) && !err.message.includes('supersecret1'),
    );
  });

  it('a retired harness name is explained, never read', async () => {
    const { p, lines } = plugin({ VITE_FW_PROJECT_API_KEY: 'project-api-key_old12345' });
    const config = injected(await p.config({}, { command: 'serve', mode: 'development' }));
    assert.equal(config['key'], undefined);
    assert.ok(lines.some((l) => l.includes('VITE_FW_PROJECT_API_KEY is not read')));
  });

  it('never injects FIREWEAVE_KEY', async () => {
    const { p } = plugin({ FIREWEAVE_KEY: 'project-api-key_server1234', FIREWEAVE_ENV: 'development' });
    const result = await p.config({}, { command: 'serve', mode: 'development' });
    assert.doesNotMatch(JSON.stringify(result), /server1234/);
  });

  it('preview and library builds inject nothing', async () => {
    assert.equal(await plugin().p.config({}, { command: 'serve', mode: 'production', isPreview: true }), undefined);
    const lib = plugin();
    assert.equal(await lib.p.config({ build: { lib: { entry: 'x.ts' } } }, { command: 'build', mode: 'production' }), undefined);
    assert.ok(lib.lines.some((l) => l.includes('build.lib')));
  });
});

describe('fireweave() Vite plugin: guards', () => {
  it('an envPrefix that would expose a server key fails', () => {
    const { p } = plugin();
    assert.throws(() => p.configResolved({ envPrefix: ['VITE_', 'FIREWEAVE_'] }), /would expose FIREWEAVE_KEY/);
    assert.throws(() => p.configResolved({ envPrefix: 'FW_' }), /FW_PROJECT_API_KEY/);
    assert.doesNotThrow(() => p.configResolved({ envPrefix: 'VITE_' }));
  });

  it('a client chunk holding a server key fails the build, naming the file only', () => {
    const { p } = plugin({ FIREWEAVE_KEY: 'literal-server-value-123' });
    p.configResolved({});
    const ctx = {};
    assert.throws(
      () => p.generateBundle.call(ctx, {}, { 'assets/a.js': { type: 'chunk', code: 'const k = "project-api-key_abcdefgh123";' } }),
      (err: Error) => err.message.includes('assets/a.js') && !err.message.includes('abcdefgh123'),
    );
    assert.throws(() => p.generateBundle.call(ctx, {}, { 'b.js': { type: 'chunk', code: 'x("literal-server-value-123")' } }), /b\.js contains a server key/);
    assert.doesNotThrow(() => p.generateBundle.call(ctx, {}, { 'c.js': { type: 'chunk', code: `start({ key: "${BROWSER_KEY}" })` } }));
  });

  it('server bundles are not scanned', () => {
    const { p } = plugin();
    p.configResolved({});
    const ssr = { environment: { config: { consumer: 'server' } } };
    assert.doesNotThrow(() => p.generateBundle.call(ssr, {}, { 'server.js': { type: 'chunk', code: 'project-api-key_abcdefgh123' } }));
  });
});

describe('fireweaveDefine() and assertFireweaveBuild()', () => {
  const quiet = { log: () => undefined };

  it('NODE_ENV=production without a key fails the build', () => {
    assert.throws(() => assertFireweaveBuild({ env: { NODE_ENV: 'production' }, ...quiet }), /FIREWEAVE_BROWSER_KEY is not set and the environment is 'production' \(from NODE_ENV\)/);
  });

  it('NODE_ENV=development without a key is local', () => {
    assert.equal(assertFireweaveBuild({ env: { NODE_ENV: 'development' }, ...quiet }).mode, 'local');
  });

  it('a custom key variable is read and named', () => {
    const define = fireweaveDefine({ keyVariable: 'NEXT_PUBLIC_FW_BROWSER_KEY', env: { NEXT_PUBLIC_FW_BROWSER_KEY: BROWSER_KEY }, ...quiet });
    const config = JSON.parse(define['__FIREWEAVE_WEB_CONFIG__'] ?? 'null') as Record<string, unknown>;
    assert.equal(config['key'], BROWSER_KEY);
    assert.equal(config['keySource'], 'NEXT_PUBLIC_FW_BROWSER_KEY');
    assert.throws(() => assertFireweaveBuild({ keyVariable: 'NEXT_PUBLIC_FW_BROWSER_KEY', env: { NODE_ENV: 'production' }, ...quiet }), /NEXT_PUBLIC_FW_BROWSER_KEY is not set/);
  });

  it('a same-origin proxy path is kept as is', () => {
    const define = fireweaveDefine({ env: { FIREWEAVE_BROWSER_KEY: BROWSER_KEY, FIREWEAVE_URL: '/fw' }, ...quiet });
    assert.equal((JSON.parse(define['__FIREWEAVE_WEB_CONFIG__'] ?? 'null') as Record<string, unknown>)['url'], '/fw');
  });
});
