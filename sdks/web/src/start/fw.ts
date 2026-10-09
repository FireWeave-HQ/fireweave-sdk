/**
 * `fw`: the page-wide accessor beside start(). Safe to import anywhere, in any
 * order, and to destructure at module scope.
 *
 * Reads are synchronous (a browser renders from a prefetched cache) and never
 * throw. Before start settles, or if it failed, they return the caller's
 * default, and the *Details forms an ERROR decision saying why.
 */
import {
  FireweaveError,
  type ContextInput,
  type Decision,
  type EvaluateOptions,
  type ExpectedFlagType,
  type FireweaveWebClient,
  type JsonValue,
  type RegisterTargetResult,
  type TargetKind,
  type WebControlPointsApi,
} from '../index.js';
import { clearStoredIdentity, mintDeviceId, type Persistence } from './identity.js';
import { CONTROL_POINTS_FILE } from './names.js';
import {
  currentStatus,
  notStartedError,
  rememberUser,
  setPersistenceFor,
  shutdownSlot,
  slot,
  warnOnce,
  type FireweaveWebStatus,
  type StartState,
} from './state.js';

/** The same nine read methods as the core client's controlPoints. */
export type ControlPoints = Pick<
  WebControlPointsApi,
  | 'evaluate'
  | 'getBooleanValue'
  | 'getStringValue'
  | 'getNumberValue'
  | 'getObjectValue'
  | 'getBooleanDetails'
  | 'getStringDetails'
  | 'getNumberDetails'
  | 'getObjectDetails'
>;

export interface IdentifyOptions {
  /** Defaults to 'user'. */
  readonly kind?: TargetKind;
}

export interface FireweaveWebStart {
  /** Read control points: `fw.controlPoints.getBooleanValue('key', false)`. Synchronous. */
  readonly controlPoints: ControlPoints;
  /** Sign-in and session restore: register the user, then switch decisions to their key. Never throws. */
  identify(targetingKey: string, properties?: Record<string, JsonValue>, options?: IdentifyOptions): Promise<RegisterTargetResult>;
  /** Sign-out: back to this browser's device id. Never throws. */
  reset(): Promise<void>;
  /** The anonymous key, for joining with analytics. Undefined before start. */
  deviceId(): string | undefined;
  /** Change storage at runtime, for consent: 'memory' deletes what was stored. */
  setPersistence(mode: Persistence): void;
  /** Withdraw consent and start over: clears storage and mints a fresh in-memory device id. */
  forget(): Promise<void>;
  /** Settles when the current start attempt does. Never rejects; already resolved when nothing is starting. */
  readonly ready: Promise<void>;
  /** What start() decided and how it went: mode, channel, host, key source, problem. Never the key. */
  status(): FireweaveWebStatus;
  /** Called on every state change, including the re-prefetch after identify or reset. Returns unsubscribe. */
  subscribe(listener: (state: StartState) => void): () => void;
  /** The core client, for anything the facade does not cover. Undefined until start settles. */
  client(): FireweaveWebClient | undefined;
  /** Flush and close. A later start() begins fresh. */
  shutdown(): Promise<void>;
}

function errorDecision(controlPointKey: string, defaultValue: JsonValue, err: FireweaveError): Decision {
  return {
    controlPointKey,
    value: defaultValue,
    reason: 'ERROR',
    errorKind: err.kind,
    errorCode: err.openFeatureErrorCode,
    errorMessage: err.message,
    metadata: { 'fireweave.errorKind': err.kind },
  };
}

function notes(controlPointKey: string, context: ContextInput | undefined): void {
  const s = slot();
  if (s.config?.mode === 'local' && !Object.prototype.hasOwnProperty.call(s.controlPoints, controlPointKey)) {
    warnOnce(s, `[fireweave:local] '${controlPointKey}' is not in your control points (${CONTROL_POINTS_FILE}), so it gets its default. Add it there to try it locally.`);
  }
  const perCall = context?.targetingKey;
  if (typeof perCall === 'string' && perCall !== s.currentKey) {
    warnOnce(s, '[fireweave] A per-call targetingKey does not change the decision in the browser: decisions follow fw.identify(). Drop the context argument.');
  }
}

function read<T>(controlPointKey: string, context: ContextInput | undefined, fallback: (err: FireweaveError) => T, run: (api: WebControlPointsApi) => T): T {
  const s = slot();
  if (s.client === undefined) {
    if (s.state === 'NOT_STARTED') {
      warnOnce(s, "[fireweave] A control point was read before start(). Import './fireweave/start' first in your entry module; reads serve their defaults until then.");
    }
    return fallback(notStartedError(s.state));
  }
  notes(controlPointKey, context);
  return run(s.client.controlPoints);
}

const controlPoints: ControlPoints = {
  evaluate: (controlPointKey: string, expectedType: ExpectedFlagType, defaultValue: JsonValue, context?: ContextInput, options?: EvaluateOptions) =>
    read(controlPointKey, context, (e) => errorDecision(controlPointKey, defaultValue, e), (c) => c.evaluate(controlPointKey, expectedType, defaultValue, context, options)),
  getBooleanValue: (controlPointKey: string, defaultValue: boolean, context?: ContextInput) =>
    read(controlPointKey, context, () => defaultValue, (c) => c.getBooleanValue(controlPointKey, defaultValue, context)),
  getStringValue: (controlPointKey: string, defaultValue: string, context?: ContextInput) =>
    read(controlPointKey, context, () => defaultValue, (c) => c.getStringValue(controlPointKey, defaultValue, context)),
  getNumberValue: (controlPointKey: string, defaultValue: number, context?: ContextInput) =>
    read(controlPointKey, context, () => defaultValue, (c) => c.getNumberValue(controlPointKey, defaultValue, context)),
  getObjectValue: (controlPointKey: string, defaultValue: JsonValue, context?: ContextInput) =>
    read(controlPointKey, context, () => defaultValue, (c) => c.getObjectValue(controlPointKey, defaultValue, context)),
  getBooleanDetails: (controlPointKey: string, defaultValue: boolean, context?: ContextInput) =>
    read(controlPointKey, context, (e) => errorDecision(controlPointKey, defaultValue, e), (c) => c.getBooleanDetails(controlPointKey, defaultValue, context)),
  getStringDetails: (controlPointKey: string, defaultValue: string, context?: ContextInput) =>
    read(controlPointKey, context, (e) => errorDecision(controlPointKey, defaultValue, e), (c) => c.getStringDetails(controlPointKey, defaultValue, context)),
  getNumberDetails: (controlPointKey: string, defaultValue: number, context?: ContextInput) =>
    read(controlPointKey, context, (e) => errorDecision(controlPointKey, defaultValue, e), (c) => c.getNumberDetails(controlPointKey, defaultValue, context)),
  getObjectDetails: (controlPointKey: string, defaultValue: JsonValue, context?: ContextInput) =>
    read(controlPointKey, context, (e) => errorDecision(controlPointKey, defaultValue, e), (c) => c.getObjectDetails(controlPointKey, defaultValue, context)),
};

/** Run identity changes one at a time, after start settles. */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const s = slot();
  const run = s.chain.then(() => s.ready).then(task);
  s.chain = run.catch(() => undefined);
  return run;
}

/** Re-prefetch under `key` when it differs from the current one. */
async function switchTo(key: string): Promise<void> {
  const s = slot();
  if (s.client === undefined || key === s.currentKey) return;
  s.currentKey = key;
  try {
    await s.client.runtime.setContext({ targetingKey: key });
  } catch {
    // the runtime reports a failed prefetch through its state; never throw from here
  }
}

export const fw: FireweaveWebStart = Object.freeze({
  controlPoints: Object.freeze(controlPoints),

  identify(targetingKey: string, properties?: Record<string, JsonValue>, options: IdentifyOptions = {}): Promise<RegisterTargetResult> {
    return serialized(async () => {
      const s = slot();
      if (s.client === undefined) {
        warnOnce(s, '[fireweave] fw.identify() ran before FireWeave started; the user was not registered.');
        return { ok: false, error: notStartedError(s.state) };
      }
      if (typeof targetingKey !== 'string' || targetingKey.trim() === '') {
        return { ok: false, error: new FireweaveError('InvalidContext') };
      }
      const result = await s.client.registerTarget(targetingKey, {
        kind: options.kind ?? 'user',
        ...(properties !== undefined ? { properties } : {}),
      });
      await switchTo(targetingKey);
      rememberUser(s, targetingKey);
      return result;
    }).catch(() => ({ ok: false, error: new FireweaveError('Internal') }));
  },

  reset(): Promise<void> {
    return serialized(async () => {
      const s = slot();
      rememberUser(s, undefined);
      if (s.identity !== undefined) await switchTo(s.identity.deviceId);
    }).catch(() => undefined);
  },

  deviceId: () => slot().identity?.deviceId,

  setPersistence(mode: Persistence): void {
    setPersistenceFor(mode);
  },

  forget(): Promise<void> {
    return serialized(async () => {
      const s = slot();
      setPersistenceFor('memory');
      clearStoredIdentity();
      if (s.identity === undefined) return;
      s.identity = { deviceId: mintDeviceId(), durable: false };
      s.appDeviceId = false;
      await switchTo(s.identity.deviceId);
    }).catch(() => undefined);
  },

  get ready(): Promise<void> {
    return slot().ready;
  },

  status: (): FireweaveWebStatus => currentStatus(),

  subscribe(listener: (state: StartState) => void): () => void {
    const s = slot();
    s.listeners.add(listener);
    return () => {
      s.listeners.delete(listener);
    };
  },

  client: (): FireweaveWebClient | undefined => slot().client,

  shutdown: (): Promise<void> => shutdownSlot(),
});
