/**
 * Web start profile (src/start/): start(), the page singleton and the `fw`
 * facade, against the built package under happy-dom with an injected fetch.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { start, fw, defineControlPoints, resetForTests } from '@fireweaveai/web-sdk/start';

const BROWSER_KEY = 'fw_public_test_abc123';
const controlPoints = defineControlPoints({ 'new-checkout': { local: true }, 'old-path': { local: false } });
const g = globalThis as Record<string, unknown>;

interface Call {
  readonly path: string;
  readonly url: string;
  readonly auth: string | null;
  readonly body: Record<string, unknown>;
}

/** A fake fw-server: `decide` maps a targeting key to its boolean decisions. */
function fakeServer(decide: (targetingKey: string) => Record<string, boolean> = () => ({ 'new-checkout': true }), status = 200) {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ path: new URL(url).pathname, url, auth: new Headers(init?.headers).get('authorization'), body });
    if (status !== 200) return new Response('{}', { status });
    if (url.endsWith('/v1/control-points/evaluate')) {
      const decisions = Object.entries(decide(String(body['targetingKey']))).map(([controlPointKey, value]) => ({
        controlPointKey,
        value,
        reason: 'TARGETING_MATCH',
        found: true,
      }));
      return Response.json({ decisions });
    }
    return Response.json({ ok: true });
  }) as typeof globalThis.fetch;
  const evaluations = () => calls.filter((c) => c.path.endsWith('/v1/control-points/evaluate'));
  const registrations = () => calls.filter((c) => c.path.endsWith('/v1/targets/register'));
  return { fetch, calls, evaluations, registrations };
}

let lines: string[] = [];
const log = (line: string): void => {
  lines.push(line);
};
let errors: string[] = [];
const originalError = console.error;

beforeEach(async () => {
  await resetForTests();
  delete g['__FIREWEAVE_WEB_CONFIG__'];
  localStorage.clear();
  lines = [];
  errors = [];
  console.error = (line: string) => void errors.push(String(line));
});
afterEach(async () => {
  await resetForTests();
  delete g['__FIREWEAVE_WEB_CONFIG__'];
  console.error = originalError;
});

describe('local mode', () => {
  it('serves the control-points object when the build config says development', async () => {
    g['__FIREWEAVE_WEB_CONFIG__'] = { v: 1, environment: 'development', environmentSource: "Vite mode 'development'" };
    await start({ controlPoints, log });
    assert.equal(fw.status().state, 'READY');
    assert.equal(fw.status().mode, 'local');
    assert.equal(fw.status().modeSource, 'environment');
    assert.equal(fw.controlPoints.getBooleanValue('new-checkout', false), true);
    assert.equal(fw.controlPoints.getBooleanValue('old-path', true), false);
    assert.equal(lines.filter((l) => l.startsWith('[fireweave:local] Local mode')).length, 1);
    assert.equal(localStorage.getItem('fireweave.device-id'), null, 'local mode stores nothing');
  });

  it('a key missing from the control-points object gets its default and warns once', async () => {
    await start({ controlPoints, mode: 'local', log });
    assert.equal(fw.controlPoints.getBooleanValue('not-declared', false), false);
    assert.equal(fw.controlPoints.getBooleanValue('not-declared', false), false);
    assert.equal(lines.filter((l) => l.includes("'not-declared' is not in your control points")).length, 1);
  });

  it("mode: 'local' ignores a key, with one warning", async () => {
    await start({ controlPoints, mode: 'local', key: BROWSER_KEY, log });
    assert.equal(fw.status().mode, 'local');
    assert.ok(lines.some((l) => l.includes("mode 'local' ignores the key from start({ key })")));
  });
});

describe('configuration faults never throw', () => {
  it('no key and no environment: FAILED, one console.error, defaults', async () => {
    await start({ controlPoints, log });
    const status = fw.status();
    assert.equal(status.state, 'FAILED');
    assert.equal(status.problem?.reason, 'missing-key');
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? '', /is not set and no environment name is set/);
    assert.equal(fw.controlPoints.getBooleanValue('new-checkout', false), false);
    const decision = fw.controlPoints.getBooleanDetails('new-checkout', false);
    assert.equal(decision.reason, 'ERROR');
    assert.equal(decision.errorKind, 'Configuration');
  });

  it('a production environment without a key names the environment', async () => {
    await start({ controlPoints, environment: 'production', log });
    assert.equal(fw.status().problem?.reason, 'missing-key');
    assert.match(errors[0] ?? '', /the environment is 'production' \(from start\(\{ environment \}\)\)/);
  });

  it('a server key is refused without printing it', async () => {
    await start({ controlPoints, key: 'project-api-key_abc123secret', log });
    assert.equal(fw.status().problem?.reason, 'server-key');
    assert.equal(errors.length, 1);
    assert.doesNotMatch(errors[0] ?? '', /abc123secret/);
    assert.match(errors[0] ?? '', /revoke/);
  });

  it('other key families are refused', async () => {
    for (const key of ['fw_org_x1', 'cli_at_x1', 'fw_ingest_pub_x1', 'random']) {
      await resetForTests();
      await start({ controlPoints, key, log });
      assert.equal(fw.status().problem?.reason, 'wrong-key-family', key);
    }
  });

  it('an http endpoint off loopback is refused', async () => {
    await start({ controlPoints, key: BROWSER_KEY, url: 'http://fw.example.com', log });
    assert.equal(fw.status().problem?.reason, 'insecure-url');
  });

  it('a bad control-points object is refused', async () => {
    await start({ controlPoints: { 'x': { local: 'yes' } } as never, mode: 'local', log });
    assert.equal(fw.status().problem?.reason, 'invalid-control-points');
    assert.match(errors[0] ?? '', /controlPoints\['x'\] must be/);
  });

  it('a corrected start() runs after a failed one', async () => {
    await start({ controlPoints, log });
    await start({ controlPoints, mode: 'local', log });
    assert.equal(fw.status().state, 'READY');
  });
});

describe('remote mode', () => {
  it('prefetches under a stored device id and registers the device once', async () => {
    const server = fakeServer();
    await start({ controlPoints, key: BROWSER_KEY, fetch: server.fetch, log });
    assert.equal(fw.status().state, 'READY');
    assert.equal(fw.controlPoints.getBooleanValue('new-checkout', false), true);
    const deviceId = fw.deviceId();
    assert.match(deviceId ?? '', /^dev_/);
    assert.equal(localStorage.getItem('fireweave.device-id'), deviceId);
    assert.equal(server.evaluations()[0]?.body['targetingKey'], deviceId);
    assert.equal(server.evaluations()[0]?.auth, `Bearer ${BROWSER_KEY}`);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(server.registrations().length, 1);
    assert.equal(server.registrations()[0]?.body['kind'], 'device');
    assert.equal(localStorage.getItem('fireweave.device-registered'), deviceId);
  });

  it('defaults the endpoint to the SDK channel host', async () => {
    const server = fakeServer();
    await start({ controlPoints, key: BROWSER_KEY, fetch: server.fetch, log });
    assert.equal(server.evaluations()[0]?.url, 'https://app-server.fireweave.ai/v1/control-points/evaluate');
    assert.equal(fw.status().host, 'app-server.fireweave.ai');
    assert.equal(fw.status().endpointSource, 'SDK channel (production)');
  });

  it('a same-origin path resolves against the page origin', async () => {
    const server = fakeServer();
    await start({ controlPoints, key: BROWSER_KEY, url: '/fw', fetch: server.fetch, log });
    assert.equal(fw.status().state, 'READY');
    assert.equal(server.evaluations()[0]?.url, `${location.origin}/fw/v1/control-points/evaluate`);
  });

  it('takes key, url and environment from the build config; explicit options win', async () => {
    g['__FIREWEAVE_WEB_CONFIG__'] = { v: 1, key: 'fw_public_from_build', keySource: 'FIREWEAVE_BROWSER_KEY' };
    const server = fakeServer();
    await start({ controlPoints, fetch: server.fetch, log });
    assert.equal(fw.status().keySource, 'FIREWEAVE_BROWSER_KEY');
    assert.equal(server.evaluations()[0]?.auth, 'Bearer fw_public_from_build');
    await resetForTests();
    await start({ controlPoints, key: BROWSER_KEY, fetch: server.fetch, log });
    assert.equal(fw.status().keySource, 'start({ key })');
  });

  it('a returning visitor keeps their device id', async () => {
    localStorage.setItem('fireweave.device-id', 'dev_returning');
    const server = fakeServer();
    await start({ controlPoints, key: BROWSER_KEY, fetch: server.fetch, log });
    assert.equal(fw.deviceId(), 'dev_returning');
    assert.equal(server.evaluations()[0]?.body['targetingKey'], 'dev_returning');
  });

  it("persistence 'memory' writes nothing and registers nothing until consent", async () => {
    const server = fakeServer();
    await start({ controlPoints, key: BROWSER_KEY, persistence: 'memory', fetch: server.fetch, log });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(localStorage.length, 0);
    assert.equal(server.registrations().length, 0);
    fw.setPersistence('localStorage');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(localStorage.getItem('fireweave.device-id'), fw.deviceId());
    assert.equal(server.registrations().length, 1);
    fw.setPersistence('memory');
    assert.equal(localStorage.getItem('fireweave.device-id'), null);
  });

  it('an app-supplied device id is used verbatim and not stored', async () => {
    const server = fakeServer();
    await start({ controlPoints, key: BROWSER_KEY, deviceId: 'analytics-123', fetch: server.fetch, log });
    assert.equal(fw.deviceId(), 'analytics-123');
    assert.equal(localStorage.getItem('fireweave.device-id'), null);
  });
});

describe('without a DOM (SSR, workers, DOM-less tests)', () => {
  const withoutDom = async (run: () => Promise<void>): Promise<void> => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { value: undefined, configurable: true, writable: true });
    try {
      await run();
    } finally {
      if (saved !== undefined) Object.defineProperty(globalThis, 'window', saved);
    }
  };

  it('remote mode is a no-op: nothing starts, nothing is stored', async () => {
    const server = fakeServer();
    await withoutDom(async () => {
      await start({ controlPoints, key: BROWSER_KEY, fetch: server.fetch, log });
    });
    assert.equal(server.calls.length, 0);
    assert.equal(fw.status().state, 'NOT_STARTED');
    assert.equal(localStorage.length, 0);
  });

  it('local mode still serves the control-points object, so server and client render agree', async () => {
    await withoutDom(async () => {
      await start({ controlPoints, mode: 'local', log });
      assert.equal(fw.controlPoints.getBooleanValue('new-checkout', false), true);
    });
  });
});

describe('identity', () => {
  it('identify registers the user and switches decisions to their key; reset switches back', async () => {
    const server = fakeServer((key) => ({ 'new-checkout': key === 'user-1' }));
    await start({ controlPoints, key: BROWSER_KEY, fetch: server.fetch, log });
    assert.equal(fw.controlPoints.getBooleanValue('new-checkout', false), false);

    const result = await fw.identify('user-1', { plan: 'pro' });
    assert.equal(result.ok, true);
    const userReg = server.registrations().find((c) => c.body['targetingKey'] === 'user-1');
    assert.equal(userReg?.body['kind'], 'user');
    assert.deepEqual(userReg?.body['properties'], { plan: 'pro' });
    assert.equal(fw.controlPoints.getBooleanValue('new-checkout', false), true);
    assert.equal(localStorage.getItem('fireweave.identity'), 'user-1');

    const before = server.evaluations().length;
    await fw.identify('user-1');
    assert.equal(server.evaluations().length, before, 'the same key does not re-prefetch');

    await fw.reset();
    assert.equal(fw.controlPoints.getBooleanValue('new-checkout', false), false);
    assert.equal(localStorage.getItem('fireweave.identity'), null);
    assert.equal(server.evaluations().at(-1)?.body['targetingKey'], fw.deviceId());
  });

  it('a stored identity is the boot key on the next page load', async () => {
    localStorage.setItem('fireweave.identity', 'user-9');
    const server = fakeServer();
    await start({ controlPoints, key: BROWSER_KEY, fetch: server.fetch, log });
    assert.equal(server.evaluations()[0]?.body['targetingKey'], 'user-9');
  });

  it('a blank key is refused and leaves the context alone', async () => {
    const server = fakeServer();
    await start({ controlPoints, key: BROWSER_KEY, fetch: server.fetch, log });
    const result = await fw.identify('   ');
    assert.equal(result.ok, false);
    assert.equal(result.error?.kind, 'InvalidContext');
    assert.equal(server.evaluations().length, 1);
  });

  it('identify before start resolves { ok: false } with one warning', async () => {
    const result = await fw.identify('user-1');
    assert.equal(result.ok, false);
    assert.equal(result.error?.kind, 'NotReady');
  });

  it('concurrent identify then reset: the last call wins', async () => {
    const server = fakeServer();
    await start({ controlPoints, key: BROWSER_KEY, fetch: server.fetch, log });
    void fw.identify('user-1');
    await fw.reset();
    assert.equal(server.evaluations().at(-1)?.body['targetingKey'], fw.deviceId());
  });

  it('forget clears storage and switches to a fresh in-memory id', async () => {
    const server = fakeServer();
    await start({ controlPoints, key: BROWSER_KEY, fetch: server.fetch, log });
    const first = fw.deviceId();
    await fw.forget();
    assert.notEqual(fw.deviceId(), first);
    assert.equal(localStorage.getItem('fireweave.device-id'), null);
    assert.equal(server.evaluations().at(-1)?.body['targetingKey'], fw.deviceId());
  });
});

describe('network faults keep their cause', () => {
  it('401 is key-rejected: STALE, one console.error without the key', async () => {
    const server = fakeServer(undefined, 401);
    await start({ controlPoints, key: BROWSER_KEY, fetch: server.fetch, log });
    assert.equal(fw.status().state, 'STALE');
    assert.equal(fw.status().problem?.reason, 'key-rejected');
    assert.equal(errors.length, 1);
    assert.doesNotMatch(errors[0] ?? '', /abc123/);
    assert.equal(fw.controlPoints.getBooleanValue('new-checkout', false), false);
  });

  it('a rejected fetch is unreachable: STALE at once, one warning', async () => {
    const failing = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof globalThis.fetch;
    const started = Date.now();
    await start({ controlPoints, key: BROWSER_KEY, fetch: failing, log });
    assert.ok(Date.now() - started < 1_000);
    assert.equal(fw.status().state, 'STALE');
    assert.equal(fw.status().problem?.reason, 'unreachable');
    assert.equal(lines.filter((l) => l.includes('Could not reach fw-server')).length, 1);
  });
});

describe('singleton and lifecycle', () => {
  it('the same options twice is one start; different options keep the first', async () => {
    const server = fakeServer();
    const a = start({ controlPoints, key: BROWSER_KEY, fetch: server.fetch, log });
    const b = start({ controlPoints, key: BROWSER_KEY, fetch: server.fetch, log });
    assert.equal(a, b);
    await a;
    assert.equal(server.evaluations().length, 1);
    await start({ controlPoints, key: 'fw_public_other', fetch: server.fetch, log });
    assert.equal(errors.filter((l) => /different configuration/.test(l)).length, 1);
    assert.equal(server.evaluations()[0]?.auth, `Bearer ${BROWSER_KEY}`);
  });

  it('a bad repeat start() keeps the running client', async () => {
    await start({ controlPoints, mode: 'local', log });
    await start({ controlPoints, key: 'project-api-key_abc123secret', log });
    assert.equal(fw.status().state, 'READY');
    assert.equal(fw.controlPoints.getBooleanValue('new-checkout', false), true);
    assert.equal(errors.filter((l) => /Keeping the running configuration/.test(l)).length, 1);
  });

  it('a read before start returns the default and warns once', () => {
    assert.equal(fw.controlPoints.getBooleanValue('new-checkout', true), true);
    const decision = fw.controlPoints.getBooleanDetails('new-checkout', false);
    assert.equal(decision.errorKind, 'NotReady');
    assert.equal(decision.errorCode, 'PROVIDER_NOT_READY');
  });

  it('a per-call targetingKey that differs warns once', async () => {
    await start({ controlPoints, mode: 'local', log });
    fw.controlPoints.getBooleanValue('new-checkout', false, { targetingKey: 'someone-else' });
    fw.controlPoints.getBooleanValue('new-checkout', false, { targetingKey: 'someone-else' });
    assert.equal(lines.filter((l) => l.includes('per-call targetingKey')).length, 1);
  });

  it('subscribe fires on settle and on an identity re-prefetch', async () => {
    const seen: string[] = [];
    const off = fw.subscribe((state) => seen.push(state));
    const server = fakeServer();
    await start({ controlPoints, key: BROWSER_KEY, fetch: server.fetch, log });
    assert.ok(seen.includes('READY'));
    const count = seen.length;
    await fw.identify('user-1');
    assert.ok(seen.length > count);
    off();
    const after = seen.length;
    await fw.reset();
    assert.equal(seen.length, after);
  });

  it('fw.ready never rejects and is resolved when nothing is starting', async () => {
    await fw.ready;
    await start({ controlPoints, log });
    await fw.ready;
  });

  it('after shutdown reads serve defaults, and start() begins again', async () => {
    await start({ controlPoints, mode: 'local', log });
    await fw.shutdown();
    assert.equal(fw.status().state, 'SHUTDOWN');
    assert.equal(fw.controlPoints.getBooleanValue('new-checkout', false), false);
    await start({ controlPoints, mode: 'local', log });
    assert.equal(fw.controlPoints.getBooleanValue('new-checkout', false), true);
  });

  it('status never includes the key', async () => {
    const server = fakeServer();
    await start({ controlPoints, key: BROWSER_KEY, fetch: server.fetch, log });
    assert.doesNotMatch(JSON.stringify(fw.status()), /abc123/);
  });
});
