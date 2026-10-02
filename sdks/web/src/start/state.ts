/**
 * start() and the page-wide singleton behind `fw`.
 *
 * One slot per page (or worker) at a Symbol.for key on globalThis, so HMR
 * re-evaluation and two bundled copies of this package share one client.
 *
 * Nothing here throws or rejects. A browser that fails to start must still
 * render: a configuration fault logs one console.error, sets the state to
 * FAILED and `problem`, and every read serves its default. The build helpers
 * (`/vite`, `/define`) are where a bad configuration fails loudly.
 */
import { FireweaveError, initFireweave, type FireweaveWebClient, type LifecycleState } from '../index.js';
import { SDK_CHANNEL, SDK_VERSION } from './build-info.js';
import { normalizeFlags, toLocalControlPoints, type FlagMap } from './flags.js';
import {
  clearStoredIdentity,
  loadIdentity,
  mintDeviceId,
  persistIdentity,
  readItem,
  removeItem,
  writeItem,
  type Identity,
  type Persistence,
} from './identity.js';
import { BUILD_ENV, LOOPBACK_HOSTS, STORAGE_KEYS } from './names.js';
import {
  firstOf,
  resolvePolicy,
  sourced,
  type InjectedConfig,
  type PolicyConfig,
  type PolicyReason,
  type SdkChannel,
  type StartMode,
} from './policy.js';

export interface StartOptions {
  /** Control points and their local values; import from src/fireweave/flags.ts. */
  readonly flags?: FlagMap;
  /** Force a mode. Without it: a key means remote; no key means local only in a dev environment. */
  readonly mode?: StartMode;
  /** Environment name used to infer the mode. Default: what the fireweave() build plugin injected. */
  readonly environment?: string;
  /** fw-server URL, or a same-origin proxy path such as '/fw'. Default: the build config, else this SDK build's channel host. */
  readonly url?: string;
  /** Browser key (fw_public_…). Default: FIREWEAVE_BROWSER_KEY, injected by the build plugin. */
  readonly key?: string;
  /** Initial storage mode. 'memory' writes nothing until fw.setPersistence('localStorage'). Default 'localStorage'. */
  readonly persistence?: Persistence;
  /** An app-supplied anonymous id (for example the analytics id), used verbatim and not stored. */
  readonly deviceId?: string;
  /** Where [fireweave] lines go. Default: console. */
  readonly log?: (line: string) => void;
  /** Transport override for tests. */
  readonly fetch?: typeof fetch;
}

export type StartState = 'NOT_STARTED' | 'INITIALIZING' | 'READY' | 'STALE' | 'ERROR' | 'FAILED' | 'SHUTDOWN';

export interface StartProblem {
  readonly reason: PolicyReason | 'invalid-flags' | 'start-failed' | 'key-rejected' | 'unreachable';
  /** The variable or option at fault, when there is one. Never a value. */
  readonly variable?: string;
}

export interface FireweaveWebStatus {
  readonly state: StartState;
  readonly mode?: StartMode;
  readonly modeSource?: PolicyConfig['modeSource'];
  readonly channel: SdkChannel;
  readonly sdkVersion: string;
  /** fw-server host name only: never a path or a credential. */
  readonly host?: string;
  readonly endpointSource?: string;
  readonly keySource?: string;
  readonly environment?: string;
  readonly flagCount?: number;
  readonly problem?: StartProblem;
}

export interface Slot {
  readonly protocol: 1;
  state: StartState;
  /** Bumped by every start and shutdown, so a late result from an older attempt is ignored. */
  generation: number;
  fingerprint?: string | undefined;
  config?: PolicyConfig | undefined;
  flags: FlagMap;
  persistence: Persistence;
  appDeviceId: boolean;
  identity?: Identity | undefined;
  /** The key the current decisions were prefetched under. */
  currentKey?: string | undefined;
  client?: FireweaveWebClient | undefined;
  problem?: StartProblem | undefined;
  ready: Promise<void>;
  /** Serializes identify / reset / forget, so the last call wins. */
  chain: Promise<unknown>;
  log: (line: string) => void;
  readonly warned: Set<string>;
  readonly listeners: Set<(state: StartState) => void>;
  detachRuntime?: (() => void) | undefined;
}

const SLOT_KEY = Symbol.for('@fireweaveai/web-sdk/start');
let protocolWarned = false;

const defaultLog = (line: string): void => {
  if (line.startsWith('[fireweave:local]')) console.info(line);
  else console.warn(line);
};

const freshSlot = (): Slot => ({
  protocol: 1,
  state: 'NOT_STARTED',
  generation: 0,
  flags: Object.freeze({}),
  persistence: 'localStorage',
  appDeviceId: false,
  ready: Promise.resolve(),
  chain: Promise.resolve(),
  log: defaultLog,
  warned: new Set(),
  listeners: new Set(),
});

export function slot(): Slot {
  const g = globalThis as Record<symbol, unknown>;
  const existing = g[SLOT_KEY] as Slot | undefined;
  if (existing !== undefined) {
    if (existing.protocol !== 1 && !protocolWarned) {
      protocolWarned = true;
      console.warn('[fireweave] Two incompatible copies of @fireweaveai/web-sdk are loaded. Deduplicate the dependency.');
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

/** console.error once per line. Errors bypass the log sink so they always reach the console. */
export function errorOnce(s: Slot, line: string): void {
  if (s.warned.has(line)) return;
  s.warned.add(line);
  console.error(line);
}

/** Change state and notify. `always` re-notifies an unchanged state (a re-prefetch after identify). */
export function setState(s: Slot, next: StartState, always = false): void {
  if (s.state === next && !always) return;
  s.state = next;
  for (const listener of s.listeners) {
    try {
      listener(next);
    } catch {
      // a listener's bug must not break the SDK
    }
  }
}

const fromLifecycle = (state: LifecycleState): StartState => (state === 'UNINITIALIZED' ? 'INITIALIZING' : state);

declare const __FIREWEAVE_WEB_CONFIG__: unknown;

/** What the fireweave() build plugin or fireweaveDefine() injected, if anything. */
export function injectedConfig(): InjectedConfig | undefined {
  let raw: unknown;
  try {
    raw = typeof __FIREWEAVE_WEB_CONFIG__ !== 'undefined' ? __FIREWEAVE_WEB_CONFIG__ : undefined;
  } catch {
    raw = undefined;
  }
  if (typeof raw !== 'object' || raw === null || (raw as { v?: unknown }).v !== 1) return undefined;
  return raw as InjectedConfig;
}

const hasDom = (): boolean => typeof window !== 'undefined' && typeof document !== 'undefined';

/** Sorted-key JSON, so the fingerprint does not depend on property order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function fingerprintOf(config: PolicyConfig, flags: FlagMap, deviceId: string | undefined): string {
  return stableJson({
    mode: config.mode,
    url: config.url,
    key: config.key,
    allowedHosts: config.allowedHosts,
    deviceId,
    // Local values only matter in local mode.
    flags: config.mode === 'local' ? toLocalControlPoints(flags) : undefined,
  });
}

const isActive = (state: StartState): boolean =>
  state === 'INITIALIZING' || state === 'READY' || state === 'STALE' || state === 'ERROR';

function fail(s: Slot, problem: StartProblem, message: string): Promise<void> {
  // A bad repeat start() must not take down the client that is already running.
  if (isActive(s.state)) {
    errorOnce(s, `${message} Keeping the running configuration.`);
    return s.ready;
  }
  s.problem = problem;
  errorOnce(s, `${message} FireWeave is not running; reads serve their defaults.`);
  setState(s, 'FAILED');
  s.ready = Promise.resolve();
  return s.ready;
}

/** Same-origin proxy paths ('/fw') resolve against the page origin. */
function absolutize(config: PolicyConfig): PolicyConfig {
  if (config.url === undefined || !config.url.startsWith('/')) return config;
  const origin = globalThis.location.origin;
  return { ...config, url: `${origin}${config.url}`, allowedHosts: [globalThis.location.hostname, ...LOOPBACK_HOSTS] };
}

function localLine(config: PolicyConfig, flags: FlagMap): string {
  const why =
    config.modeSource === 'option'
      ? "mode 'local'"
      : `no key; environment '${config.environment ?? ''}' from ${config.environmentSource ?? 'the build config'}`;
  const n = Object.keys(flags).length;
  return `[fireweave:local] Local mode (${why}). Serving ${n} flag${n === 1 ? '' : 's'} from your flags object; nothing is sent to fw-server.`;
}

/**
 * Wrap the transport so faults the core folds into STALE keep their cause:
 * a 401/403 means the key was refused, a rejected fetch means fw-server was
 * not reachable from this page.
 */
function observedFetch(s: Slot, generation: number, base: typeof fetch, config: PolicyConfig): typeof fetch {
  const host = config.url !== undefined ? new URL(config.url).host : 'fw-server';
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      const response = await base(input, init);
      if (s.generation === generation) {
        if (response.status === 401 || response.status === 403) {
          s.problem = { reason: 'key-rejected', variable: config.keySource };
          errorOnce(
            s,
            `[fireweave] fw-server refused the browser key from ${config.keySource} (HTTP ${response.status}). Check the key is an active browser key (fw_public_…) for this project. Reads serve their defaults.`,
          );
        } else if (response.ok && (s.problem?.reason === 'key-rejected' || s.problem?.reason === 'unreachable')) {
          s.problem = undefined;
        }
      }
      return response;
    } catch (err) {
      if (s.generation === generation) {
        s.problem = { reason: 'unreachable' };
        warnOnce(
          s,
          `[fireweave] Could not reach fw-server at ${host}: offline, an ad or tracker blocker, a firewall, or a Content-Security-Policy connect-src rule. Reads serve their defaults. A same-origin proxy set through FIREWEAVE_URL avoids most of these.`,
        );
      }
      throw err;
    }
  };
  return wrapped as typeof fetch;
}

function registerDevice(s: Slot, generation: number): void {
  const { client, identity, config } = s;
  if (client === undefined || identity === undefined || config?.mode !== 'remote' || !identity.durable) return;
  if (readItem(STORAGE_KEYS.deviceRegistered) === identity.deviceId) return;
  void client.registerTarget(identity.deviceId, { kind: 'device' }).then((result) => {
    if (result.ok && s.generation === generation && s.persistence === 'localStorage') {
      writeItem(STORAGE_KEYS.deviceRegistered, identity.deviceId);
    }
  });
}

/**
 * Start FireWeave for this page. Call once, from src/fireweave/start.ts.
 *
 * Resolves when the first prefetch settles (READY, STALE or ERROR) and never
 * rejects, so `await start(...)` cannot blank a page. Check `fw.status()` for
 * the outcome.
 */
export function start(options: StartOptions = {}): Promise<void> {
  const s = slot();
  if (options.log !== undefined && (s.state === 'NOT_STARTED' || s.state === 'FAILED' || s.state === 'SHUTDOWN')) {
    s.log = options.log;
  }

  let flags: FlagMap;
  try {
    flags = normalizeFlags(options.flags);
  } catch (err) {
    return fail(s, { reason: 'invalid-flags', variable: 'flags' }, (err as Error).message);
  }

  const injected = injectedConfig();
  const policy = resolvePolicy({
    mode: options.mode,
    key: firstOf(sourced(options.key, 'start({ key })'), sourced(injected?.key, injected?.keySource ?? BUILD_ENV.key)),
    url: firstOf(sourced(options.url, 'start({ url })'), sourced(injected?.url, injected?.urlSource ?? BUILD_ENV.url)),
    environment: firstOf(
      sourced(options.environment, 'start({ environment })'),
      sourced(injected?.environment, injected?.environmentSource ?? BUILD_ENV.environment),
    ),
    channel: SDK_CHANNEL,
    keyVariable: injected !== undefined ? BUILD_ENV.key : `the browser key (start({ key }), or ${BUILD_ENV.key} through the fireweave() build plugin)`,
    environmentChecked: 'start({ environment }) and the build config',
  });
  if (!policy.ok) return fail(s, { reason: policy.reason, variable: policy.variable }, policy.message);

  // Remote mode without a DOM (SSR, a worker, a DOM-less test) does nothing:
  // a server-side singleton would share one visitor's identity across requests.
  if (policy.config.mode === 'remote' && !hasDom()) return Promise.resolve();

  const config = absolutize(policy.config);
  const fingerprint = fingerprintOf(config, flags, options.deviceId);
  if (isActive(s.state)) {
    if (fingerprint !== s.fingerprint) {
      errorOnce(s, '[fireweave] start() was already called with a different configuration; keeping the first one. Call start() once, from src/fireweave/start.ts.');
    }
    return s.ready;
  }

  const generation = s.generation + 1;
  s.generation = generation;
  s.fingerprint = fingerprint;
  s.config = config;
  s.flags = flags;
  s.problem = undefined;
  s.client = undefined;
  s.persistence = options.persistence === 'memory' ? 'memory' : 'localStorage';
  s.appDeviceId = options.deviceId !== undefined;
  s.chain = Promise.resolve();
  for (const w of policy.warnings) warnOnce(s, w);

  // Local mode stores nothing and registers nothing: the id lives for this page only.
  const identity: Identity =
    config.mode === 'local'
      ? { deviceId: options.deviceId ?? mintDeviceId(), durable: false }
      : loadIdentity(s.persistence, options.deviceId);
  s.identity = identity;
  s.currentKey = identity.user ?? identity.deviceId;
  if (config.mode === 'local') s.log(localLine(config, flags));
  setState(s, 'INITIALIZING');

  const base = options.fetch ?? globalThis.fetch?.bind(globalThis);
  const init =
    config.mode === 'local'
      ? initFireweave({
          mode: 'local',
          local: { controlPoints: toLocalControlPoints(flags), log: (line) => s.log(line) },
          context: { targetingKey: s.currentKey },
        })
      : initFireweave({
          mode: 'remote',
          apiKey: config.key as string,
          apiUrl: config.url as string,
          ...(config.allowedHosts !== undefined ? { allowedHosts: config.allowedHosts } : {}),
          ...(base !== undefined ? { fetch: observedFetch(s, generation, base, config) } : {}),
          context: { targetingKey: s.currentKey },
        });

  s.ready = init.then(
    (client) => {
      if (s.generation !== generation) {
        void client.shutdown();
        return;
      }
      s.client = client;
      s.detachRuntime = client.runtime.onStateChange((state) => {
        if (s.generation === generation) setState(s, fromLifecycle(state), true);
      });
      setState(s, fromLifecycle(client.runtime.getState()));
      registerDevice(s, generation);
    },
    () => {
      if (s.generation !== generation) return;
      s.problem = { reason: 'start-failed' };
      errorOnce(s, '[fireweave] start failed: the core rejected the configuration. FireWeave is not running; reads serve their defaults.');
      setState(s, 'FAILED');
    },
  );
  return s.ready;
}

export function currentStatus(): FireweaveWebStatus {
  const s = slot();
  const c = s.config;
  const active = s.state !== 'NOT_STARTED' && s.state !== 'FAILED';
  return {
    state: s.state,
    channel: SDK_CHANNEL,
    sdkVersion: SDK_VERSION,
    ...(c !== undefined && active
      ? {
          mode: c.mode,
          modeSource: c.modeSource,
          keySource: c.keySource,
          flagCount: Object.keys(s.flags).length,
          ...(c.url !== undefined && c.urlSource !== undefined ? { host: new URL(c.url).hostname, endpointSource: c.urlSource } : {}),
          ...(c.environment !== undefined ? { environment: c.environment } : {}),
        }
      : {}),
    ...(s.problem !== undefined ? { problem: s.problem } : {}),
  };
}

/** Switch storage at runtime, for consent. Never part of the start() configuration check. */
export function setPersistenceFor(mode: Persistence): void {
  const s = slot();
  if (mode !== 'localStorage' && mode !== 'memory') return;
  const previous = s.persistence;
  s.persistence = mode;
  if (s.identity === undefined || s.config?.mode !== 'remote' || previous === mode) return;
  if (mode === 'memory') {
    clearStoredIdentity();
    return;
  }
  const user = s.currentKey !== s.identity.deviceId ? s.currentKey : undefined;
  s.identity.durable = persistIdentity(s.identity, user, s.appDeviceId);
  registerDevice(s, s.generation);
}

/** Store (or clear) the signed-in key, when persistence allows it. */
export function rememberUser(s: Slot, user: string | undefined): void {
  if (s.config?.mode !== 'remote' || s.persistence !== 'localStorage') return;
  if (user === undefined) removeItem(STORAGE_KEYS.identity);
  else writeItem(STORAGE_KEYS.identity, user);
}

export async function shutdownSlot(): Promise<void> {
  const s = slot();
  await s.ready;
  const client = s.client;
  s.generation += 1;
  s.detachRuntime?.();
  s.client = undefined;
  s.fingerprint = undefined;
  s.ready = Promise.resolve();
  setState(s, 'SHUTDOWN');
  if (client !== undefined) await client.shutdown();
}

/** Test only: shut down and forget the singleton so the next start() begins fresh. */
export async function resetForTests(): Promise<void> {
  const g = globalThis as Record<symbol, unknown>;
  const s = g[SLOT_KEY] as Slot | undefined;
  if (s !== undefined) {
    s.generation += 1;
    s.detachRuntime?.();
    if (s.client !== undefined) await s.client.shutdown().catch(() => undefined);
  }
  delete g[SLOT_KEY];
}

export const notStartedError = (state: StartState): FireweaveError =>
  new FireweaveError(state === 'FAILED' ? 'Configuration' : state === 'SHUTDOWN' ? 'AlreadyClosed' : 'NotReady');
