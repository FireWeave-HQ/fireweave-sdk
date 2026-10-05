/**
 * Start profile SP-27: when fw-server refuses the key (401/403), rate-limits
 * (429) or cannot be reached, the start profile logs ONE line per group for the
 * life of the process, naming the key's source or the endpoint host and never
 * the key, and keeps the latest kind in status().lastErrorKind.
 *
 * Recovery: lastErrorKind is sticky (a later success leaves it set; a fresh
 * start() after shutdown clears it), and a group's line is not repeated after
 * a recovery.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { start, fw, resetForTests } from '../../src/start/index.ts';

const KEY = 'project-api-key_sp27secretvalue';
const URL_ = 'https://fw.example.com';

let lines: string[] = [];
const log = (line: string): void => void lines.push(line);

/** A transport answering each call with the next scripted outcome (the last one repeats). */
function scripted(...outcomes: Array<number | 'network' | 'timeout'>) {
  let i = 0;
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const next = outcomes[Math.min(i, outcomes.length - 1)];
    i += 1;
    if (next === 'network') throw new TypeError('fetch failed');
    if (next === 'timeout') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const body = next === 200 ? { decisions: [{ flagKey: 'f', value: true, reason: 'TARGETING_MATCH', found: true }] } : {};
    return { status: next as number, text: async () => JSON.stringify(body), json: async () => body };
  };
  return { fetch, calls };
}

const read = () => fw.controlPoints.getBooleanDetails('f', false, { targetingKey: 'u1' });
const keyLines = () => lines.filter((l) => l.startsWith('[fireweave]'));

beforeEach(async () => {
  await resetForTests();
  lines = [];
});
afterEach(() => resetForTests());

describe('SP-27: a refused key is visible', () => {
  it('401: one line naming FIREWEAVE_KEY and the host, never the key; lastErrorKind set', async () => {
    const t = scripted(401);
    start({ env: { FIREWEAVE_KEY: KEY, FIREWEAVE_URL: URL_ }, log, fetch: t.fetch });
    const decision = await read();
    assert.equal(decision.value, false);
    assert.equal(decision.errorKind, 'Authentication');
    assert.equal(keyLines().length, 1);
    assert.match(keyLines()[0]!, /rejected the key from FIREWEAVE_KEY \(HTTP 401\)/);
    assert.match(keyLines()[0]!, /fw\.example\.com/);
    assert.equal(fw.status().lastErrorKind, 'Authentication');
    assert.doesNotMatch(lines.join('\n') + JSON.stringify(fw.status()), /sp27secretvalue/);
  });

  it('repeated failures of the same kind log once', async () => {
    start({ env: { FIREWEAVE_KEY: KEY, FIREWEAVE_URL: URL_ }, log, fetch: scripted(401).fetch });
    for (let n = 0; n < 5; n += 1) await read();
    assert.equal(keyLines().length, 1);
  });

  it('names the actual source: a start({ key }) option or the legacy FW_PROJECT_API_KEY', async () => {
    start({ key: KEY, url: URL_, env: {}, log, fetch: scripted(403).fetch });
    await read();
    assert.match(keyLines().at(-1)!, /refused the key from start\(\{ key \}\) .*\(HTTP 403\)/);
    assert.equal(fw.status().lastErrorKind, 'Authorization');
    await resetForTests();
    lines = [];
    start({ env: { FW_PROJECT_API_KEY: KEY, FIREWEAVE_URL: URL_ }, log, fetch: scripted(401).fetch });
    await read();
    assert.ok(keyLines().some((l) => /rejected the key from FW_PROJECT_API_KEY/.test(l)));
    assert.doesNotMatch(lines.join('\n'), /sp27secretvalue/);
  });

  it('429 and an unreachable endpoint each log their own line; lastErrorKind is the latest kind', async () => {
    start({ env: { FIREWEAVE_KEY: KEY, FIREWEAVE_URL: URL_ }, log, fetch: scripted(429, 'network', 'timeout', 503, 401).fetch });
    await read();
    assert.equal(fw.status().lastErrorKind, 'RateLimited');
    await read();
    assert.equal(fw.status().lastErrorKind, 'Network');
    await read();
    assert.equal(fw.status().lastErrorKind, 'Timeout');
    await read();
    assert.equal(fw.status().lastErrorKind, 'BackendUnavailable');
    await read();
    assert.equal(fw.status().lastErrorKind, 'Authentication');
    const ls = keyLines();
    assert.equal(ls.filter((l) => /rate-limited the key from FIREWEAVE_KEY \(HTTP 429\)/.test(l)).length, 1);
    // Network, Timeout and 5xx share the "unreachable" group: one line, naming the endpoint's source.
    assert.equal(ls.filter((l) => /Could not reach fw-server at fw\.example\.com \(endpoint from FIREWEAVE_URL; network error\)/.test(l)).length, 1);
    assert.equal(ls.filter((l) => /Could not reach/.test(l)).length, 1);
    assert.equal(ls.filter((l) => /HTTP 401/.test(l)).length, 1);
    assert.equal(ls.length, 3);
  });

  it('recovery: a success keeps lastErrorKind and does not re-arm the line', async () => {
    start({ env: { FIREWEAVE_KEY: KEY, FIREWEAVE_URL: URL_ }, log, fetch: scripted(401, 200, 401).fetch });
    await read();
    const ok = await read();
    assert.equal(ok.value, true);
    assert.equal(fw.status().lastErrorKind, 'Authentication');
    await read();
    assert.equal(keyLines().length, 1);
  });

  it('a fresh start() after shutdown clears lastErrorKind; the line stays once per process', async () => {
    start({ env: { FIREWEAVE_KEY: KEY, FIREWEAVE_URL: URL_ }, log, fetch: scripted(401).fetch });
    await read();
    await fw.shutdown();
    start({ env: { FIREWEAVE_KEY: KEY, FIREWEAVE_URL: URL_ }, log, fetch: scripted(200, 401).fetch });
    assert.equal(fw.status().lastErrorKind, undefined);
    await read();
    assert.equal(fw.status().lastErrorKind, undefined);
    await read();
    assert.equal(fw.status().lastErrorKind, 'Authentication');
    assert.equal(keyLines().length, 1);
  });

  it('a throwing log sink does not turn a 401 into a transport failure', async () => {
    start({ env: { FIREWEAVE_KEY: KEY, FIREWEAVE_URL: URL_ }, log: () => { throw new Error('sink'); }, fetch: scripted(401).fetch });
    assert.equal((await read()).errorKind, 'Authentication');
  });

  it('identify() failures are observed too', async () => {
    start({ env: { FIREWEAVE_KEY: KEY, FIREWEAVE_URL: URL_ }, log, fetch: scripted(401).fetch });
    assert.equal((await fw.identify('u1')).ok, false);
    assert.equal(fw.status().lastErrorKind, 'Authentication');
    assert.equal(keyLines().length, 1);
  });

  it('local mode makes no requests and never sets lastErrorKind', async () => {
    start({ mode: 'local', env: {}, flags: { f: { local: true } }, log });
    await read();
    assert.equal(fw.status().lastErrorKind, undefined);
  });
});
