import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FireweaveRemoteWebAdapter,
  FireweaveWebClient,
  FireweaveWebRuntime,
} from '@fireweaveai/web-sdk';

/**
 * The exposure-flush-on-unload path, against a REAL DOM.
 *
 * This is the one part of the SDK with no server analogue: a server process
 * gets a shutdown hook, a browser tab can vanish without warning. Everything
 * here — `pagehide`, `visibilitychange`, `keepalive` — exists because of that.
 *
 * These tests are why happy-dom is preloaded. The SDK guards every browser-only
 * API it touches, so without a DOM `attachUnloadFlush()` silently takes its
 * no-op branch and the suite would report this path as covered while never
 * executing a line of it.
 *
 * Still not covered, and it is worth being precise about: happy-dom's event
 * loop is not a browser's. bfcache restore, beacon size limits, and whether the
 * request actually leaves the socket during unload are real-browser behaviours
 * no headless DOM can assert.
 */

interface Recorded {
  url: string;
  keepalive: boolean;
  body: string;
}

function harness() {
  const calls: Recorded[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      keepalive: init?.keepalive === true,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const adapter = new FireweaveRemoteWebAdapter({
    apiUrl: 'https://app-server.fireweave.ai',
    apiKey: 'project-api-key_test',
    fetch: fetchImpl,
  });
  return { calls, adapter };
}

async function readyClient() {
  const { calls, adapter } = harness();
  const runtime = new FireweaveWebRuntime(adapter, {
    globalContext: { targetingKey: 'user_42' },
  });
  await runtime.initialize();
  // autoFlushOnUnload defaults to true — that default is part of what is tested.
  const client = new FireweaveWebClient(runtime);
  return { calls, client, runtime };
}

const EXPOSURE = {
  flagKey: 'web-checkout',
  targetingKey: 'user_42',
  value: true,
  variant: 'on',
};

/** Drain the microtask queue so a fire-and-forget flush has actually run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('happy-dom is actually installed — otherwise these tests prove nothing', () => {
  assert.equal(typeof globalThis.document, 'object');
  assert.equal(typeof globalThis.addEventListener, 'function');
});

test('pagehide flushes queued exposures over a keepalive request', async () => {
  const { calls, client, runtime } = await readyClient();
  client.exposures.record(EXPOSURE);
  const before = calls.length;

  globalThis.dispatchEvent(new Event('pagehide'));
  await settle();

  const flushes = calls.slice(before);
  assert.equal(flushes.length, 1, 'expected exactly one capture request on pagehide');
  assert.equal(flushes[0]?.keepalive, true, 'unload delivery must survive the page going away');
  assert.match(flushes[0]?.url ?? '', /\/v1\/capture$/);
  assert.match(flushes[0]?.body ?? '', /web-checkout/);

  await runtime.shutdown();
});

test('visibilitychange flushes only when the document is actually hidden', async () => {
  const { calls, client, runtime } = await readyClient();
  client.exposures.record(EXPOSURE);
  const before = calls.length;

  // Visible: a tab-switch away and back must not drain the queue early.
  Object.defineProperty(globalThis.document, 'visibilityState', {
    value: 'visible',
    configurable: true,
  });
  globalThis.dispatchEvent(new Event('visibilitychange'));
  await settle();
  assert.equal(calls.length, before, 'a visible document must not trigger a flush');

  Object.defineProperty(globalThis.document, 'visibilityState', {
    value: 'hidden',
    configurable: true,
  });
  globalThis.dispatchEvent(new Event('visibilitychange'));
  await settle();
  assert.equal(calls.length, before + 1, 'hidden must flush');

  await runtime.shutdown();
});

test('detaching removes the listeners', async () => {
  const { calls, client, runtime } = await readyClient();
  const detach = client.exposures.attachUnloadFlush();
  detach();

  client.exposures.record(EXPOSURE);
  const before = calls.length;
  globalThis.dispatchEvent(new Event('pagehide'));
  await settle();

  assert.equal(calls.length, before, 'no flush should fire after detach');
  await runtime.shutdown();
});

test('an empty queue makes no request — unload must not emit noise', async () => {
  const { calls, runtime } = await readyClient();
  const before = calls.length;

  globalThis.dispatchEvent(new Event('pagehide'));
  await settle();

  assert.equal(calls.length, before);
  await runtime.shutdown();
});

test('a failed unload flush never throws into the page', async () => {
  const calls: Recorded[] = [];
  const failing = (async () => {
    calls.push({ url: 'x', keepalive: true, body: '' });
    throw new Error('network gone');
  }) as unknown as typeof fetch;

  const runtime = new FireweaveWebRuntime(
    new FireweaveRemoteWebAdapter({
      apiUrl: 'https://app-server.fireweave.ai',
      apiKey: 'project-api-key_test',
      fetch: failing,
    }),
    { globalContext: { targetingKey: 'user_42' } }
  );
  await runtime.initialize();
  const client = new FireweaveWebClient(runtime);
  client.exposures.record(EXPOSURE);

  // Unload-time delivery is best-effort by definition: neither sendBeacon nor a
  // keepalive fetch reports failure to the page, and an analytics call must not
  // surface as an unhandled rejection while the user is navigating away.
  globalThis.dispatchEvent(new Event('pagehide'));
  await settle();

  assert.ok(calls.length >= 1, 'the attempt should still have been made');
  await runtime.shutdown();
});
