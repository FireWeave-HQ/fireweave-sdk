/**
 * start() and the process-wide singleton behind `fw`.
 *
 * One slot per process (or worker thread) at a Symbol.for key on globalThis,
 * so two bundled copies of this package share one client. start() is
 * synchronous: it resolves and validates everything up front, throws a
 * Configuration error for bad config, then hands off to the unchanged core
 * initFireweave(). Reads await readiness and never throw.
 *
 * A read that happens before any start() schedules an env-only start on the
 * next macrotask. An ES module graph without top-level await evaluates in one
 * job, so an entrypoint that imports ./fireweave/start first always wins.
 */
import {
  FireweaveError,
  initFireweave,
  isFireweaveError,
  stableStringify,
  type FireweaveClient,
  type FireweaveErrorKind,
  type FireweaveRemoteAdapterOptions,
  type InitFireweaveOptions,
} from '../index.js';
import { SDK_CHANNEL, SDK_VERSION } from './build-info.js';
import { envFromBag, processEnv, type EnvReader } from './env.js';
import { toLocalControlPoints, type ControlPointMap } from './control-points.js';
import { deriveInstanceKey, type InstanceKey } from './instance.js';
import { resolveStart, type ResolvedStart, type SdkChannel, type StartMode } from './resolve.js';

export interface StartOptions {
  /** Control points and their local values; import from src/fireweave/control-points.ts. */
  readonly controlPoints?: ControlPointMap;
  /** Force a mode. Without it: a key means remote; no key means local only in a dev environment. */
  readonly mode?: StartMode;
  /** Environment name used to infer the mode, instead of FIREWEAVE_ENV, APP_ENV or NODE_ENV. */
  readonly environment?: string;
  /** fw-server URL. Default: FIREWEAVE_URL, else this SDK build's channel host. */
  readonly url?: string;
  /** Project key (project-api-key_…). Default: FIREWEAVE_KEY. */
  readonly key?: string;
  /** Stable id for this process in server-subject reads. Default: FIREWEAVE_INSTANCE_ID, else the host. */
  readonly instanceId?: string;
  /** Read these values instead of the process environment (tests, Workers bindings). */
  readonly env?: Readonly<Record<string, unknown>>;
  /** Where [fireweave] lines go. Default: console. Not part of the idempotency check. */
  readonly log?: (line: string) => void;
  /** Transport override for tests. Not part of the idempotency check. */
  readonly fetch?: FireweaveRemoteAdapterOptions['fetch'];
}

export type StartState = 'unstarted' | 'starting' | 'ready' | 'failed' | 'shutdown';

export interface FireweaveStatus {
  readonly state: StartState;
  readonly mode?: StartMode;
  readonly modeSource?: ResolvedStart['modeSource'];
  readonly channel: SdkChannel;
  readonly sdkVersion: string;
  /** fw-server host name only: never a path or a credential. */
  readonly host?: string;
  readonly endpointSource?: string;
  readonly keySource?: string;
  readonly environment?: string;
  readonly controlPointCount?: number;
  /** Why start failed, when it did. Already redacted. */
  readonly error?: string;
  /**
   * The kind of the latest failed fw-server request (Authentication,
   * Authorization, RateLimited, Network, Timeout or BackendUnavailable).
   * Sticky: a later success does not clear it; a fresh start() does.
   */
  readonly lastErrorKind?: FireweaveErrorKind;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

interface Slot {
  readonly protocol: 1;
  state: StartState;
  signature?: string;
  implicit: boolean;
  resolved?: ResolvedStart;
  ready: Deferred<FireweaveClient | undefined>;
  client?: FireweaveClient | undefined;
  error?: FireweaveError;
  implicitScheduled: boolean;
  read?: EnvReader;
  instanceIdOption?: string;
  instance?: InstanceKey;
  log: (line: string) => void;
  readonly warned: Set<string>;
  lastErrorKind?: FireweaveErrorKind;
  /** fw-server failure groups already logged; one line each for the life of the process. */
  readonly diagnosed: Set<string>;
}

const SLOT_KEY = Symbol.for('@fireweaveai/server-sdk/start');

const defaultLog = (line: string): void => {
  if (line.startsWith('[fireweave:local]')) console.info(line);
  else console.warn(line);
};

const freshSlot = (): Slot => ({
  protocol: 1,
  state: 'unstarted',
  implicit: false,
  ready: deferred(),
  implicitScheduled: false,
  log: defaultLog,
  warned: new Set(),
  diagnosed: new Set(),
});

export function slot(): Slot {
  const g = globalThis as Record<symbol, unknown>;
  const existing = g[SLOT_KEY] as Slot | undefined;
  if (existing !== undefined) {
    if (existing.protocol !== 1) {
      throw new FireweaveError('Configuration', {
        message: '[fireweave] Two incompatible copies of @fireweaveai/server-sdk are loaded. Deduplicate the dependency.',
      });
    }
    return existing;
  }
  const created = freshSlot();
  g[SLOT_KEY] = created;
  return created;
}

export function warnOnce(s: Slot, line: string): void {
  if (s.warned.has(line)) return;
  s.warned.add(line);
  s.log(line);
}

const signatureOf = (r: ResolvedStart, instanceId: string | undefined): string =>
  stableStringify({
    mode: r.mode,
    url: r.url ?? null,
    key: r.key ?? null,
    allowedHosts: r.allowedHosts !== undefined ? [...r.allowedHosts] : null,
    instanceId: instanceId ?? null,
    // Seeds only matter in local mode; remote ignores them, so an env-only
    // implicit start followed by start({ controlPoints }) under a key is not a conflict.
    ...(r.mode === 'local' ? { controlPoints: toLocalControlPoints(r.controlPoints) } : {}),
  });

function localLine(r: ResolvedStart): string {
  const why = r.modeSource === 'option'
    ? "start({ mode: 'local' })"
    : `no FIREWEAVE_KEY; environment '${r.environment ?? ''}' from ${r.environmentSource ?? 'env'}`;
  const n = Object.keys(r.controlPoints).length;
  return `[fireweave:local] Local mode (${why}). Serving ${n} control point${n === 1 ? '' : 's'} from your control-points object; nothing is sent to fw-server.`;
}

type Transport = NonNullable<FireweaveRemoteAdapterOptions['fetch']>;

/** The kind the core's remote adapter reports for an HTTP status, or undefined for a success. */
function kindForStatus(status: number): FireweaveErrorKind | undefined {
  if (status < 400) return undefined;
  if (status === 401) return 'Authentication';
  if (status === 403) return 'Authorization';
  if (status === 429) return 'RateLimited';
  return 'BackendUnavailable';
}

/**
 * SP-27: a refused key, a rate limit or an unreachable fw-server is logged
 * once per group for the life of the process and kept as lastErrorKind, so a
 * revoked key does not look like a rollout at 0%. Lines name the key's source
 * and the host, never the key.
 */
function observeFailure(s: Slot, token: Slot['ready'], r: ResolvedStart, kind: FireweaveErrorKind, detail: string): void {
  if (s.ready !== token) return; // a response for a client that was shut down or replaced
  s.lastErrorKind = kind;
  const host = r.url !== undefined ? new URL(r.url).host : 'fw-server';
  let group: string;
  let line: string;
  switch (kind) {
    case 'Authentication':
      group = 'key-rejected-401';
      line = `[fireweave] fw-server at ${host} rejected the key from ${r.keySource} (HTTP 401): it is wrong, revoked or from another project. Reads serve their defaults; this is not a rollout at 0%.`;
      break;
    case 'Authorization':
      group = 'key-rejected-403';
      line = `[fireweave] fw-server at ${host} refused the key from ${r.keySource} for this project or environment (HTTP 403). Reads serve their defaults; this is not a rollout at 0%.`;
      break;
    case 'RateLimited':
      group = 'rate-limited';
      line = `[fireweave] fw-server at ${host} rate-limited the key from ${r.keySource} (HTTP 429). Reads serve their defaults until a request succeeds.`;
      break;
    default:
      group = 'unreachable';
      line = `[fireweave] Could not reach fw-server at ${host} (endpoint from ${r.urlSource ?? 'the SDK channel'}; ${detail}): offline, a firewall, or the wrong endpoint. Reads serve their defaults until a request succeeds.`;
  }
  if (s.diagnosed.has(group)) return;
  s.diagnosed.add(group);
  try {
    s.log(line);
  } catch {
    // A faulty log sink must not turn into a transport failure.
  }
}

/** The transport handed to the core, observed. The core's behaviour is unchanged. */
function observedTransport(s: Slot, token: Slot['ready'], r: ResolvedStart, base: Transport | undefined): Transport {
  return async (url, init) => {
    const call = base ?? (globalThis.fetch as unknown as Transport);
    let response: Awaited<ReturnType<Transport>>;
    try {
      response = await call(url, init);
    } catch (err) {
      // The same split the core makes: its own deadline aborts the request.
      const timedOut = err instanceof Error && err.name === 'AbortError';
      observeFailure(s, token, r, timedOut ? 'Timeout' : 'Network', timedOut ? 'timed out' : 'network error');
      throw err;
    }
    const kind = kindForStatus(response.status);
    if (kind !== undefined) observeFailure(s, token, r, kind, `HTTP ${response.status}`);
    return response;
  };
}

function initOptions(r: ResolvedStart, options: StartOptions, s: Slot, token: Slot['ready']): InitFireweaveOptions {
  if (r.mode === 'local') {
    return { mode: 'local', local: { controlPoints: toLocalControlPoints(r.controlPoints), log: (line) => s.log(line) } };
  }
  return {
    mode: 'remote',
    apiKey: r.key as string,
    apiUrl: r.url as string,
    ...(r.allowedHosts !== undefined ? { allowedHosts: r.allowedHosts } : {}),
    fetch: observedTransport(s, token, r, options.fetch),
  };
}

/** Start FireWeave for this process. Synchronous; call once, from src/fireweave/start.ts. */
export function start(options: StartOptions = {}): void {
  startWith(options, false);
}

export function startWith(options: StartOptions, implicit: boolean): void {
  const s = slot();
  if (s.state === 'shutdown' || s.state === 'failed') {
    // Warnings and fw-server failure lines are once per process, across restarts.
    Object.assign(s, freshSlot(), { warned: s.warned, diagnosed: s.diagnosed });
    delete s.lastErrorKind; // freshSlot() has no such key, so assign alone would keep it
  }

  const read = options.env !== undefined ? envFromBag(options.env) : processEnv();
  const resolved = resolveStart(options, read, { version: SDK_VERSION, channel: SDK_CHANNEL });
  const signature = signatureOf(resolved, options.instanceId);

  if (s.state === 'starting' || s.state === 'ready') {
    if (signature === s.signature) return;
    throw new FireweaveError('Configuration', {
      message: s.implicit
        ? "[fireweave] A control point was read before start() ran, so FireWeave started from the environment alone. Import './fireweave/start' as the first import of your entrypoint."
        : '[fireweave] start() was already called with a different configuration. Call start() once, from src/fireweave/start.ts.',
    });
  }

  if (options.instanceId !== undefined && s.instance !== undefined && s.instance.value !== options.instanceId) {
    throw new FireweaveError('Configuration', {
      message: '[fireweave] start({ instanceId }) differs from the instanceKey() already handed out. Pass instanceId on the first start().',
    });
  }

  // Only a start that actually begins sets the log sink: an identical second
  // start() is a no-op and a conflicting one throws, and neither may swap it.
  if (!implicit && options.log !== undefined) s.log = options.log;
  s.state = 'starting';
  s.signature = signature;
  s.implicit = implicit;
  s.resolved = resolved;
  s.read = read;
  if (options.instanceId !== undefined) s.instanceIdOption = options.instanceId;
  for (const w of resolved.warnings) warnOnce(s, w);
  if (resolved.mode === 'local') s.log(localLine(resolved));

  const ready = s.ready;
  const pending = initFireweave(initOptions(resolved, options, s, ready)).then(
    (client) => {
      if (s.ready !== ready) return undefined; // superseded by shutdown/restart
      s.state = 'ready';
      s.client = client;
      return client;
    },
    (err: unknown) => {
      if (s.ready !== ready) return undefined;
      s.state = 'failed';
      s.error = isFireweaveError(err) ? err : new FireweaveError('Internal', { cause: err });
      warnOnce(s, `[fireweave] start failed: ${s.error.message}. Reads serve their defaults.`);
      return undefined;
    },
  );
  ready.resolve(pending);
}

/** The client once start() settles; undefined when start failed. Schedules an implicit start if none ran. */
export function ensureClient(): Promise<FireweaveClient | undefined> {
  const s = slot();
  if (s.state === 'unstarted' && !s.implicitScheduled) {
    s.implicitScheduled = true;
    setTimeout(() => {
      if (s.state !== 'unstarted') return;
      try {
        startWith({}, true);
      } catch (err) {
        s.state = 'failed';
        s.error = isFireweaveError(err) ? err : new FireweaveError('Internal', { cause: err });
        warnOnce(s, `${s.error.message} (FireWeave was not started; reads serve their defaults.)`);
        s.ready.resolve(undefined);
      }
    }, 0);
  }
  return s.ready.promise;
}

export function currentStatus(): FireweaveStatus {
  const s = slot();
  const r = s.resolved;
  return {
    state: s.state,
    channel: r?.channel ?? SDK_CHANNEL,
    sdkVersion: r?.sdkVersion ?? SDK_VERSION,
    ...(r !== undefined
      ? {
          mode: r.mode,
          modeSource: r.modeSource,
          keySource: r.keySource,
          controlPointCount: Object.keys(r.controlPoints).length,
          ...(r.url !== undefined ? { host: new URL(r.url).hostname, endpointSource: r.urlSource } : {}),
          ...(r.environment !== undefined ? { environment: r.environment } : {}),
        }
      : {}),
    ...(s.error !== undefined ? { error: s.error.message } : {}),
    ...(s.lastErrorKind !== undefined ? { lastErrorKind: s.lastErrorKind } : {}),
  };
}

export function instanceKeyFor(): string {
  const s = slot();
  if (s.instance === undefined) s.instance = deriveInstanceKey(s.instanceIdOption, s.read ?? processEnv());
  return s.instance.value;
}

export async function shutdownSlot(): Promise<void> {
  const s = slot();
  const client = s.state === 'starting' ? await s.ready.promise : s.client;
  s.state = 'shutdown';
  s.client = undefined;
  s.ready = deferred();
  s.ready.resolve(undefined);
  s.implicitScheduled = true; // no implicit restart after an explicit shutdown
  if (client !== undefined) await client.shutdown();
}

/** Test only: shut down and forget the singleton so the next start() begins fresh. */
export async function resetForTests(): Promise<void> {
  const g = globalThis as Record<symbol, unknown>;
  const s = g[SLOT_KEY] as Slot | undefined;
  if (s?.client !== undefined) await s.client.shutdown().catch(() => undefined);
  delete g[SLOT_KEY];
}
