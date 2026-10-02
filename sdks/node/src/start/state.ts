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
  type FireweaveRemoteAdapterOptions,
  type InitFireweaveOptions,
} from '../index.js';
import { SDK_CHANNEL, SDK_VERSION } from './build-info.js';
import { envFromBag, processEnv, type EnvReader } from './env.js';
import { toLocalControlPoints, type FlagMap } from './flags.js';
import { deriveInstanceKey, type InstanceKey } from './instance.js';
import { resolveStart, type ResolvedStart, type SdkChannel, type StartMode } from './resolve.js';

export interface StartOptions {
  /** Control points and their local values; import from src/fireweave/flags.ts. */
  readonly flags?: FlagMap;
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
  readonly flagCount?: number;
  /** Why start failed, when it did. Already redacted. */
  readonly error?: string;
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
    // implicit start followed by start({ flags }) under a key is not a conflict.
    ...(r.mode === 'local' ? { flags: toLocalControlPoints(r.flags) } : {}),
  });

function localLine(r: ResolvedStart): string {
  const why = r.modeSource === 'option'
    ? "start({ mode: 'local' })"
    : `no FIREWEAVE_KEY; environment '${r.environment ?? ''}' from ${r.environmentSource ?? 'env'}`;
  const n = Object.keys(r.flags).length;
  return `[fireweave:local] Local mode (${why}). Serving ${n} flag${n === 1 ? '' : 's'} from your flags object; nothing is sent to fw-server.`;
}

function initOptions(r: ResolvedStart, options: StartOptions, s: Slot): InitFireweaveOptions {
  if (r.mode === 'local') {
    return { mode: 'local', local: { controlPoints: toLocalControlPoints(r.flags), log: (line) => s.log(line) } };
  }
  return {
    mode: 'remote',
    apiKey: r.key as string,
    apiUrl: r.url as string,
    ...(r.allowedHosts !== undefined ? { allowedHosts: r.allowedHosts } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  };
}

/** Start FireWeave for this process. Synchronous; call once, from src/fireweave/start.ts. */
export function start(options: StartOptions = {}): void {
  startWith(options, false);
}

export function startWith(options: StartOptions, implicit: boolean): void {
  const s = slot();
  if (s.state === 'shutdown' || s.state === 'failed') {
    const kept = s.warned;
    Object.assign(s, freshSlot(), { warned: kept });
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
  const pending = initFireweave(initOptions(resolved, options, s)).then(
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
          flagCount: Object.keys(r.flags).length,
          ...(r.url !== undefined ? { host: new URL(r.url).hostname, endpointSource: r.urlSource } : {}),
          ...(r.environment !== undefined ? { environment: r.environment } : {}),
        }
      : {}),
    ...(s.error !== undefined ? { error: s.error.message } : {}),
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
