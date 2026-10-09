/**
 * `fw`: the singleton accessor beside start(). Safe to import anywhere, in any
 * order. Every read awaits start and never throws: if start failed, reads
 * serve the caller's default (or an ERROR decision for the *Details forms).
 */
import {
  FireweaveError,
  type ContextInput,
  type ControlPointsApi,
  type Decision,
  type EvaluateOptions,
  type ExpectedFlagType,
  type FireweaveClient,
  type JsonValue,
  type RegisterTargetResult,
  type TargetKind,
} from '../index.js';
import { currentStatus, ensureClient, instanceKeyFor, shutdownSlot, slot, warnOnce, type FireweaveStatus } from './state.js';

/** The same nine read methods as the core client's controlPoints. */
export type ControlPoints = Pick<
  ControlPointsApi,
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
  readonly signal?: AbortSignal;
}

export interface FireweaveStart {
  /** Read control points: `await fw.controlPoints.getBooleanValue('key', false, { targetingKey })`. */
  readonly controlPoints: ControlPoints;
  /** Register durable targeting facts at sign-in. Resolves { ok }, never throws. */
  identify(targetingKey: string, properties?: Record<string, JsonValue>, options?: IdentifyOptions): Promise<RegisterTargetResult>;
  /** Stable key for reads where the server is the subject (cron, boot). No disk writes. */
  instanceKey(): string;
  /** What start() decided: mode, channel, host, key source. Never includes the key. */
  status(): FireweaveStatus;
  /** The core client, for anything the facade does not cover. Rejects if start failed. */
  client(): Promise<FireweaveClient>;
  /** Flush and close. A later start() begins fresh. */
  shutdown(): Promise<void>;
}

const startFailure = (): FireweaveError =>
  slot().error ?? new FireweaveError('Configuration', { message: '[fireweave] FireWeave was not started.' });

const errorDecision = (controlPointKey: string, defaultValue: JsonValue): Decision => {
  const err = startFailure();
  return {
    controlPointKey,
    value: defaultValue,
    reason: 'ERROR',
    errorKind: err.kind,
    errorCode: err.openFeatureErrorCode,
    errorMessage: err.message,
    metadata: {},
  };
};

/** Local mode: a key missing from the control-points object gets its default, with one warning. */
function noteLocalKey(controlPointKey: string): void {
  const s = slot();
  const r = s.resolved;
  if (r?.mode !== 'local' || Object.prototype.hasOwnProperty.call(r.controlPoints, controlPointKey)) return;
  warnOnce(
    s,
    `[fireweave:local] '${controlPointKey}' is not in your control points (src/fireweave/control-points.ts), so it gets its default. Add it there to try it locally.`,
  );
}

async function read<T>(controlPointKey: string, fallback: () => T, run: (client: FireweaveClient) => Promise<T>): Promise<T> {
  const client = await ensureClient();
  if (client === undefined) return fallback();
  noteLocalKey(controlPointKey);
  return run(client);
}

const controlPoints: ControlPoints = {
  evaluate: (controlPointKey: string, expectedType: ExpectedFlagType, defaultValue: JsonValue, context?: ContextInput, options?: EvaluateOptions) =>
    read(controlPointKey, () => errorDecision(controlPointKey, defaultValue), (c) => c.controlPoints.evaluate(controlPointKey, expectedType, defaultValue, context, options)),
  getBooleanValue: (controlPointKey: string, defaultValue: boolean, context?: ContextInput) =>
    read(controlPointKey, () => defaultValue, (c) => c.controlPoints.getBooleanValue(controlPointKey, defaultValue, context)),
  getStringValue: (controlPointKey: string, defaultValue: string, context?: ContextInput) =>
    read(controlPointKey, () => defaultValue, (c) => c.controlPoints.getStringValue(controlPointKey, defaultValue, context)),
  getNumberValue: (controlPointKey: string, defaultValue: number, context?: ContextInput) =>
    read(controlPointKey, () => defaultValue, (c) => c.controlPoints.getNumberValue(controlPointKey, defaultValue, context)),
  getObjectValue: (controlPointKey: string, defaultValue: JsonValue, context?: ContextInput) =>
    read(controlPointKey, () => defaultValue, (c) => c.controlPoints.getObjectValue(controlPointKey, defaultValue, context)),
  getBooleanDetails: (controlPointKey: string, defaultValue: boolean, context?: ContextInput) =>
    read(controlPointKey, () => errorDecision(controlPointKey, defaultValue), (c) => c.controlPoints.getBooleanDetails(controlPointKey, defaultValue, context)),
  getStringDetails: (controlPointKey: string, defaultValue: string, context?: ContextInput) =>
    read(controlPointKey, () => errorDecision(controlPointKey, defaultValue), (c) => c.controlPoints.getStringDetails(controlPointKey, defaultValue, context)),
  getNumberDetails: (controlPointKey: string, defaultValue: number, context?: ContextInput) =>
    read(controlPointKey, () => errorDecision(controlPointKey, defaultValue), (c) => c.controlPoints.getNumberDetails(controlPointKey, defaultValue, context)),
  getObjectDetails: (controlPointKey: string, defaultValue: JsonValue, context?: ContextInput) =>
    read(controlPointKey, () => errorDecision(controlPointKey, defaultValue), (c) => c.controlPoints.getObjectDetails(controlPointKey, defaultValue, context)),
};

export const fw: FireweaveStart = Object.freeze({
  controlPoints: Object.freeze(controlPoints),
  async identify(targetingKey: string, properties?: Record<string, JsonValue>, options: IdentifyOptions = {}): Promise<RegisterTargetResult> {
    const client = await ensureClient();
    if (client === undefined) return { ok: false };
    try {
      return await client.registerTarget(targetingKey, {
        kind: options.kind ?? 'user',
        ...(properties !== undefined ? { properties } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    } catch {
      return { ok: false };
    }
  },
  instanceKey: (): string => instanceKeyFor(),
  status: (): FireweaveStatus => currentStatus(),
  async client(): Promise<FireweaveClient> {
    const client = await ensureClient();
    if (client === undefined) throw startFailure();
    return client;
  },
  shutdown: (): Promise<void> => shutdownSlot(),
});
