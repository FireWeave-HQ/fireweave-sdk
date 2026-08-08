/**
 * Fireweave deterministic protocol stub (test-server/README.md,
 * implementation/PLAN.md). Loopback-only Node HTTP server; no dependencies.
 *
 * PostHog-protocol endpoints (advanced / PostHogAdapter):
 *   POST /flags/?v=2 (and /flags?v=2)      — flags v2 evaluation body
 *   GET  /flags/definitions?token=...      — local-eval definitions (Bearer auth)
 *   POST /batch/ (and /batch)              — event capture, stored in memory
 *
 * Fireweave remote protocol (ADR-0005 / FireweaveRemoteAdapter):
 *   POST /v1/flags/evaluate  — vendor-neutral evaluate (Bearer FW key)
 *   POST /v1/capture         — exposures/signals/events batch (Bearer FW key)
 *
 *   GET  /health                           — {"ok":true}
 * Admin control plane:
 *   POST /_test/fault        {"mode","status","delayMs","ttlRequests","applyTo","body"}
 *   POST /_test/flags        replace flags v2 success body
 *   POST /_test/definitions  replace definitions body
 *   POST /_test/reset        clear faults/events, restore fixture defaults
 *   GET  /_test/events       captured batch events (insert order)
 *
 * Fault modes: delay | 401 | 429 | 500 | invalid_json | truncated | quota_limited
 * applyTo: flags | definitions | batch | evaluate | capture | all (default flags)
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const loadFixture = (name) => JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8'));
const loadFixtureText = (name) => readFileSync(join(FIXTURES_DIR, name), 'utf8');

const FIXTURES = {
  flagsSuccess: () => loadFixture('flags-v2-success.json'),
  flagsQuotaLimited: () => loadFixture('flags-v2-quota-limited.json'),
  flagsEmpty: () => loadFixture('flags-v2-empty.json'),
  definitions: () => loadFixture('definitions.json'),
  batchAccept: () => loadFixture('batch-accept.json'),
  fault401: () => loadFixture('fault-401.json'),
  fault429: () => loadFixture('fault-429.json'),
  fault500: () => loadFixture('fault-500.json'),
  invalidJsonBody: () => loadFixtureText('invalid-json.body.txt'),
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isLoopback = (host) =>
  host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === undefined;

/**
 * @param {object} [options]
 * @param {number} [options.port=3901]
 * @param {string} [options.host='127.0.0.1']
 * @param {string} [options.projectApiKey] accept only this token when set (PostHog body token OR FW Bearer)
 * @param {string} [options.secretApiKey]  required Bearer key for definitions when set
 * @param {string} [options.fireweaveApiKey] accept only this Bearer for /v1/* when set (defaults to projectApiKey)
 * @param {boolean} [options.allowNonLoopback=false]
 */
export async function startTestServer(options = {}) {
  const port = options.port ?? 3901;
  const host = options.host ?? '127.0.0.1';
  if (!isLoopback(host) && options.allowNonLoopback !== true) {
    throw new Error(`refusing to bind non-loopback host ${host} without allowNonLoopback`);
  }

  const state = {
    fault: null, // {mode, status?, delayMs?, ttlRequests?, applyTo?, body?}
    flagsBody: FIXTURES.flagsSuccess(),
    definitionsBody: FIXTURES.definitions(),
    events: [],
    fwEvents: [],
    requestLog: [],
  };

  const expectedFwKey = options.fireweaveApiKey ?? options.projectApiKey;

  const extractBearer = (req) => {
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
      return auth.slice(7).trim();
    }
    const xKey = req.headers['x-api-key'];
    if (typeof xKey === 'string' && xKey.trim().length > 0) return xKey.trim();
    return '';
  };

  /** Map PostHog flags fixture → Fireweave decision items (vendor-neutral). */
  const flagsToDecisions = (flagsBody, flagKeys) => {
    const all = flagsBody?.flags ?? {};
    const keys = Array.isArray(flagKeys) && flagKeys.length > 0 ? flagKeys : Object.keys(all);
    const decisions = [];
    for (const flagKey of keys) {
      const record = all[flagKey];
      if (record === undefined) {
        decisions.push({
          flagKey,
          value: null,
          reason: 'ERROR',
          found: false,
        });
        continue;
      }
      const enabled = record.enabled === true;
      const variant = record.variant ?? null;
      const value = enabled ? (variant ?? true) : false;
      const meta = {};
      if (record.metadata?.version != null) meta['fireweave.flagVersion'] = record.metadata.version;
      if (record.metadata?.id != null && record.reason?.condition_index != null) {
        meta['fireweave.vendorFlagId'] = record.metadata.id;
        if (record.reason?.code) meta['fireweave.reasonCode'] = record.reason.code;
      }
      meta['fireweave.backend'] = 'other';
      let payload;
      if (typeof record.metadata?.payload === 'string' && record.metadata.payload.length > 0) {
        try {
          payload = JSON.parse(record.metadata.payload);
        } catch {
          payload = record.metadata.payload;
        }
      }
      const item = {
        flagKey,
        value,
        variant,
        reason: enabled ? (variant ? 'SPLIT' : 'TARGETING_MATCH') : 'DISABLED',
        found: true,
        enabled,
        flagMetadata: meta,
      };
      if (payload !== undefined) item.payload = payload;
      decisions.push(item);
    }
    const quotaLimited =
      Array.isArray(flagsBody?.quotaLimited) && flagsBody.quotaLimited.includes('feature_flags');
    const out = { decisions };
    if (flagsBody?.requestId) out.requestId = flagsBody.requestId;
    if (quotaLimited) out.quotaLimited = true;
    return out;
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let buf = Buffer.concat(chunks);
        if (req.headers['content-encoding'] === 'gzip') {
          try {
            buf = gunzipSync(buf);
          } catch {
            // leave as-is
          }
        }
        resolve(buf.toString('utf8'));
      });
      req.on('error', reject);
    });

  const sendJson = (res, status, body) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(text);
  };

  const faultApplies = (scope) => {
    const fault = state.fault;
    if (fault === null) return null;
    const applyTo = fault.applyTo ?? 'flags';
    if (applyTo !== 'all' && applyTo !== scope) return null;
    return fault;
  };

  const consumeFaultTtl = () => {
    const fault = state.fault;
    if (fault !== null && typeof fault.ttlRequests === 'number') {
      fault.ttlRequests -= 1;
      if (fault.ttlRequests <= 0) state.fault = null;
    }
  };

  /** Returns true when the fault fully handled the response. */
  const applyFault = async (scope, res, successBodyProvider) => {
    const fault = faultApplies(scope);
    if (fault === null) return false;
    consumeFaultTtl();
    switch (fault.mode) {
      case 'delay':
        await sleep(fault.delayMs ?? 1000);
        return false; // then serve normally (client usually timed out already)
      case '401':
        sendJson(res, 401, FIXTURES.fault401());
        return true;
      case '429':
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
        res.end(JSON.stringify(FIXTURES.fault429()));
        return true;
      case '500':
        sendJson(res, 500, FIXTURES.fault500());
        return true;
      case 'invalid_json':
        sendJson(res, 200, fault.body ?? FIXTURES.invalidJsonBody());
        return true;
      case 'truncated': {
        const full = JSON.stringify(successBodyProvider());
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(full.length) });
        res.write(full.slice(0, Math.min(32, full.length)));
        res.destroy(); // hard close mid-body
        return true;
      }
      case 'quota_limited':
        // Quota limiting is reported in the shape of whichever protocol was
        // asked. The Fireweave route carries `quotaLimited: true` alongside
        // `decisions`; the legacy vendor route carries the vendor body. Serving
        // the vendor shape on /v1 would make the client see a parse failure
        // instead of a quota signal.
        sendJson(
          res,
          200,
          scope === 'evaluate'
            ? flagsToDecisions(FIXTURES.flagsQuotaLimited())
            : FIXTURES.flagsQuotaLimited(),
        );
        return true;
      default:
        return false;
    }
  };

  const handleFlags = async (req, res) => {
    const bodyText = await readBody(req);
    let body = {};
    try {
      body = JSON.parse(bodyText);
    } catch {
      return sendJson(res, 400, { error: 'invalid request body' });
    }
    state.requestLog.push({ path: '/flags', distinct_id: body.distinct_id });
    if (await applyFault('flags', res, () => state.flagsBody)) return undefined;
    if (typeof body.token !== 'string' || body.token.length === 0) {
      return sendJson(res, 401, FIXTURES.fault401());
    }
    if (options.projectApiKey !== undefined && body.token !== options.projectApiKey) {
      return sendJson(res, 401, FIXTURES.fault401());
    }
    let responseBody = state.flagsBody;
    const keys = body.flag_keys_to_evaluate;
    if (Array.isArray(keys)) {
      const flags = {};
      for (const key of keys) {
        if (responseBody.flags?.[key] !== undefined) flags[key] = responseBody.flags[key];
      }
      responseBody = { ...responseBody, flags };
    }
    return sendJson(res, 200, responseBody);
  };

  const handleDefinitions = async (req, res, url) => {
    state.requestLog.push({ path: '/flags/definitions' });
    if (await applyFault('definitions', res, () => state.definitionsBody)) return undefined;
    const auth = req.headers['authorization'];
    if (options.secretApiKey !== undefined && auth !== `Bearer ${options.secretApiKey}`) {
      return sendJson(res, 401, FIXTURES.fault401());
    }
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
      return sendJson(res, 401, FIXTURES.fault401());
    }
    const token = url.searchParams.get('token');
    if (options.projectApiKey !== undefined && token !== options.projectApiKey) {
      return sendJson(res, 401, FIXTURES.fault401());
    }
    return sendJson(res, 200, state.definitionsBody);
  };

  const handleBatch = async (req, res) => {
    const bodyText = await readBody(req);
    if (await applyFault('batch', res, () => FIXTURES.batchAccept())) return undefined;
    let body = {};
    try {
      body = JSON.parse(bodyText);
    } catch {
      return sendJson(res, 400, { error: 'invalid batch body' });
    }
    const batch = Array.isArray(body.batch) ? body.batch : [];
    for (const event of batch) state.events.push(event);
    return sendJson(res, 200, FIXTURES.batchAccept());
  };

  const handleFwEvaluate = async (req, res) => {
    const bodyText = await readBody(req);
    state.requestLog.push({ path: '/v1/flags/evaluate' });
    if (await applyFault('evaluate', res, () => flagsToDecisions(state.flagsBody))) return undefined;
    const key = extractBearer(req);
    if (!key) return sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' });
    if (expectedFwKey !== undefined && key !== expectedFwKey) {
      return sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' });
    }
    let body = {};
    try {
      body = JSON.parse(bodyText);
    } catch {
      return sendJson(res, 400, { ok: false, error: 'INVALID_BODY' });
    }
    if (typeof body.targetingKey !== 'string' || body.targetingKey.length === 0) {
      return sendJson(res, 400, { ok: false, error: 'TARGETING_KEY_REQUIRED' });
    }
    return sendJson(res, 200, flagsToDecisions(state.flagsBody, body.flagKeys));
  };

  const handleFwCapture = async (req, res) => {
    const bodyText = await readBody(req);
    state.requestLog.push({ path: '/v1/capture' });
    if (await applyFault('capture', res, () => ({ ok: true, accepted: 0 }))) return undefined;
    const key = extractBearer(req);
    if (!key) return sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' });
    if (expectedFwKey !== undefined && key !== expectedFwKey) {
      return sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' });
    }
    let body = {};
    try {
      body = JSON.parse(bodyText);
    } catch {
      return sendJson(res, 400, { ok: false, error: 'INVALID_BODY' });
    }
    const events = Array.isArray(body.events) ? body.events : [];
    for (const event of events) state.fwEvents.push(event);
    return sendJson(res, 200, { ok: true, accepted: events.length });
  };

  const handleAdmin = async (req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/_test/events') {
      return sendJson(res, 200, { events: state.events, fwEvents: state.fwEvents });
    }
    if (req.method === 'GET' && url.pathname === '/_test/requests') {
      return sendJson(res, 200, { requests: state.requestLog });
    }
    const bodyText = await readBody(req);
    let body = {};
    if (bodyText.length > 0) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        return sendJson(res, 400, { error: 'invalid admin body' });
      }
    }
    switch (url.pathname) {
      case '/_test/fault':
        state.fault = body.mode === undefined || body.mode === 'none' ? null : body;
        return sendJson(res, 200, { ok: true });
      case '/_test/flags':
        state.flagsBody = body;
        return sendJson(res, 200, { ok: true });
      case '/_test/definitions':
        state.definitionsBody = body;
        return sendJson(res, 200, { ok: true });
      case '/_test/reset':
        state.fault = null;
        state.flagsBody = FIXTURES.flagsSuccess();
        state.definitionsBody = FIXTURES.definitions();
        state.events = [];
        state.fwEvents = [];
        state.requestLog = [];
        return sendJson(res, 200, { ok: true });
      default:
        return sendJson(res, 404, { error: 'unknown admin endpoint' });
    }
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const route = async () => {
      if (path === '/health') return sendJson(res, 200, { ok: true });
      if (path.startsWith('/_test')) return handleAdmin(req, res, url);
      if (req.method === 'POST' && path === '/v1/flags/evaluate') return handleFwEvaluate(req, res);
      if (req.method === 'POST' && path === '/v1/capture') return handleFwCapture(req, res);
      if (req.method === 'POST' && path === '/flags') return handleFlags(req, res);
      if (req.method === 'GET' && path === '/flags/definitions') return handleDefinitions(req, res, url);
      if (req.method === 'POST' && path === '/batch') return handleBatch(req, res);
      return sendJson(res, 404, { error: `unknown route ${req.method} ${path}` });
    };
    route().catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: String(err) });
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  return {
    url: `http://${host}:${boundPort}`,
    port: boundPort,
    state,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// CLI entry: node server.mjs [--port N] [--host H]
if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const port = Number(getArg('--port') ?? 3901);
  const host = getArg('--host') ?? '127.0.0.1';
  startTestServer({ port, host, allowNonLoopback: args.includes('--allow-non-loopback') })
    .then((s) => console.log(`fireweave test-server listening on ${s.url}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
