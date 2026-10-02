/**
 * Integration: real entrypoints in child processes, where import order is real.
 *  - the recommended layout (start module imported first) beats a sibling's module-scope read
 *  - `@fireweaveai/server-sdk/register` starts from the environment alone
 *  - CommonJS apps can require() the start entry
 * Runs on Node, and on Bun when it is installed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'start');

const hasBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;
const runtimes: Array<[string, string[]]> = [['node', []], ...(hasBun ? ([['bun', ['run']]] as Array<[string, string[]]>) : [])];

const baseEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' };
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  return env;
};

const run = (cmd: string, args: string[], file: string, env: NodeJS.ProcessEnv) => {
  const result = spawnSync(cmd, [...args, join(fixtures, file)], { cwd: fixtures, env, encoding: 'utf8', timeout: 20_000 });
  const lastLine = result.stdout.trim().split('\n').at(-1) ?? '';
  return { status: result.status, out: lastLine, stderr: result.stderr, stdout: result.stdout };
};

for (const [cmd, args] of runtimes) {
  describe(`start entrypoints on ${cmd}`, () => {
    it('first-import layout: a sibling module-scope read sees the flags object', () => {
      const r = run(cmd, args, 'entry-first-import.mjs', { ...baseEnv(), NODE_ENV: 'development' });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.out), { early: true, later: true, mode: 'local' });
    });

    it('/register starts from the environment alone', () => {
      const r = run(cmd, args, 'entry-register.mjs', { ...baseEnv(), FIREWEAVE_ENV: 'local' });
      assert.equal(r.status, 0, r.stderr);
      const parsed = JSON.parse(r.out) as { value: boolean; status: { mode: string; modeSource: string } };
      assert.equal(parsed.value, false);
      assert.equal(parsed.status.mode, 'local');
      assert.equal(parsed.status.modeSource, 'environment');
    });

    it('/register in production without a key fails at boot, naming the variable', () => {
      const r = run(cmd, args, 'entry-register.mjs', { ...baseEnv(), NODE_ENV: 'production' });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /FIREWEAVE_KEY is not set/);
    });
  });
}

describe('CommonJS', () => {
  it('require() of the start entry works on Node', () => {
    const r = run('node', [], 'entry.cjs', { ...baseEnv(), NODE_ENV: 'test' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.out), { value: true });
  });
});
