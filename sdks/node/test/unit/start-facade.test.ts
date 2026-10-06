/**
 * Start profile: start(), the singleton and the `fw` facade (src/start/).
 * Idempotency, implicit start, reads never throw, local control points, identity, status.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { start, fw, defineControlPoints, resetForTests } from '../../src/start/index.ts';

const KEY = 'project-api-key_abc123';
const controlPoints = defineControlPoints({ 'new-checkout': { local: true }, 'old-path': { local: false } });
const DEV = { NODE_ENV: 'development' } as const;

let lines: string[] = [];
const log = (line: string): void => {
  lines.push(line);
};

const savedEnv = { ...process.env };
const clearProcessEnv = (): void => {
  for (const name of ['FIREWEAVE_KEY', 'FIREWEAVE_URL', 'FIREWEAVE_ENV', 'APP_ENV', 'NODE_ENV', 'FW_PROJECT_API_KEY', 'FW_API_URL', 'FW_ATTEST_URL']) {
    delete process.env[name];
  }
};

beforeEach(async () => {
  await resetForTests();
  lines = [];
  clearProcessEnv();
});
afterEach(async () => {
  await resetForTests();
  Object.assign(process.env, savedEnv);
});

describe('start(): local mode with a control-points object', () => {
  it('serves each local value and logs one local-mode line', async () => {
    start({ controlPoints, env: DEV, log });
    assert.equal(await fw.controlPoints.getBooleanValue('new-checkout', false, { targetingKey: 'u1' }), true);
    assert.equal(await fw.controlPoints.getBooleanValue('old-path', true, { targetingKey: 'u1' }), false);
    assert.equal(lines.filter((l) => l.startsWith('[fireweave:local] Local mode')).length, 1);
  });

  it('a key missing from the control-points object gets its default and warns once', async () => {
    start({ controlPoints, env: DEV, log });
    assert.equal(await fw.controlPoints.getBooleanValue('not-declared', false, { targetingKey: 'u1' }), false);
    assert.equal(await fw.controlPoints.getBooleanValue('not-declared', false, { targetingKey: 'u2' }), false);
    assert.equal(lines.filter((l) => l.includes("'not-declared' is not in your control points")).length, 1);
  });

  it("mode: 'local' works with no environment name at all", async () => {
    start({ controlPoints, mode: 'local', env: {}, log });
    assert.equal(fw.status().modeSource, 'option');
    assert.equal(await fw.controlPoints.getBooleanValue('new-checkout', false, { targetingKey: 'u1' }), true);
  });
});

describe('start(): idempotency', () => {
  it('a second start with the same config is a no-op', () => {
    start({ controlPoints, env: DEV, log });
    assert.doesNotThrow(() => start({ controlPoints, env: DEV, log }));
  });

  it('a second start with different control points throws Configuration', () => {
    start({ controlPoints, env: DEV, log });
    assert.throws(
      () => start({ controlPoints: { 'new-checkout': { local: false } }, env: DEV, log }),
      (err: unknown) => (err as { kind?: string }).kind === 'Configuration' && /different configuration/.test((err as Error).message),
    );
  });

  it('a different key is a conflict; the log sink is not part of the check', () => {
    start({ key: KEY, env: {}, log });
    assert.doesNotThrow(() => start({ key: KEY, env: {}, log: () => undefined }));
    assert.throws(() => start({ key: 'project-api-key_other', env: {}, log }), /different configuration/);
  });

  it('the first start() keeps its log sink; a repeat start() cannot swap it', async () => {
    start({ controlPoints, env: DEV, log });
    const other: string[] = [];
    start({ controlPoints, env: DEV, log: (line) => void other.push(line) });
    await fw.controlPoints.getBooleanValue('not-declared', false, { targetingKey: 'u1' });
    assert.ok(lines.some((l) => l.includes("'not-declared'")));
    assert.deepEqual(other, []);
  });

  it('bad config throws synchronously from start() itself', () => {
    assert.throws(() => start({ env: { NODE_ENV: 'production' }, log }), /FIREWEAVE_KEY is not set/);
  });
});

describe('reads before start()', () => {
  it('an explicit start() in the same turn wins over the implicit one', async () => {
    const early = fw.controlPoints.getBooleanValue('new-checkout', false, { targetingKey: 'u1' });
    start({ controlPoints, env: DEV, log });
    assert.equal(await early, true);
    assert.equal(fw.status().modeSource, 'environment');
  });

  it('with no start(), FireWeave starts from the process environment', async () => {
    process.env.FIREWEAVE_ENV = 'development';
    assert.equal(await fw.controlPoints.getBooleanValue('anything', false, { targetingKey: 'u1' }), false);
    assert.equal(fw.status().state, 'ready');
    assert.equal(fw.status().mode, 'local');
  });

  it('a failed implicit start serves defaults and an ERROR decision, never throws', async () => {
    process.env.NODE_ENV = 'production';
    const original = console.warn;
    const warned: string[] = [];
    console.warn = (line: string) => void warned.push(line);
    try {
      assert.equal(await fw.controlPoints.getBooleanValue('new-checkout', false, { targetingKey: 'u1' }), false);
      const decision = await fw.controlPoints.getBooleanDetails('new-checkout', false, { targetingKey: 'u1' });
      assert.equal(decision.reason, 'ERROR');
      assert.equal(decision.errorKind, 'Configuration');
      assert.equal(fw.status().state, 'failed');
      assert.equal((await fw.identify('u1')).ok, false);
      await assert.rejects(() => fw.client(), /FIREWEAVE_KEY is not set/);
      assert.equal(warned.filter((l) => /FIREWEAVE_KEY is not set/.test(l)).length, 1);
    } finally {
      console.warn = original;
    }
  });

  it('an explicit start() recovers after a failed implicit start', async () => {
    process.env.NODE_ENV = 'production';
    const original = console.warn;
    console.warn = () => undefined;
    try {
      await fw.controlPoints.getBooleanValue('new-checkout', false);
      start({ controlPoints, mode: 'local', env: {}, log });
      assert.equal(await fw.controlPoints.getBooleanValue('new-checkout', false, { targetingKey: 'u1' }), true);
    } finally {
      console.warn = original;
    }
  });
});

describe('identity, instance key, status, shutdown', () => {
  it('identify registers a user target and resolves { ok }', async () => {
    start({ controlPoints, env: DEV, log });
    assert.equal((await fw.identify('user-1', { plan: 'pro' })).ok, true);
    assert.ok(lines.some((l) => l.includes('registerTarget user user-1')));
  });

  it('instanceKey: option, then FIREWEAVE_INSTANCE_ID, then a host hash; stable within a process', async () => {
    start({ controlPoints, env: { ...DEV, FIREWEAVE_INSTANCE_ID: 'worker-7' }, log });
    assert.equal(fw.instanceKey(), 'worker-7');
    await resetForTests();
    start({ controlPoints, env: { ...DEV, HOSTNAME: 'api-pod-1' }, log });
    const key = fw.instanceKey();
    assert.match(key, /^inst_[0-9a-f]{16}$/);
    assert.equal(fw.instanceKey(), key);
    await resetForTests();
    start({ controlPoints, env: DEV, instanceId: 'cron-1', log });
    assert.equal(fw.instanceKey(), 'cron-1');
  });

  it('status reports the decision and never the key', async () => {
    start({ key: KEY, env: {}, log });
    const status = fw.status();
    assert.equal(status.mode, 'remote');
    assert.equal(status.modeSource, 'key');
    assert.equal(status.keySource, 'start({ key })');
    assert.equal(status.host, 'app-server.fireweave.ai');
    assert.equal(status.channel, 'production');
    assert.doesNotMatch(JSON.stringify(status), /abc123/);
  });

  it('after shutdown reads serve defaults, and start() begins again', async () => {
    start({ controlPoints, env: DEV, log });
    await fw.controlPoints.getBooleanValue('new-checkout', false);
    await fw.shutdown();
    assert.equal(await fw.controlPoints.getBooleanValue('new-checkout', false), false);
    start({ controlPoints, env: DEV, log });
    assert.equal(await fw.controlPoints.getBooleanValue('new-checkout', false, { targetingKey: 'u1' }), true);
  });
});
