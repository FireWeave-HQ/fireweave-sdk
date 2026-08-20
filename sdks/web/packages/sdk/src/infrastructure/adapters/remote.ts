/**
 * Fireweave remote adapter for browsers — the production path.
 *
 * Speaks only the vendor-neutral Fireweave remote protocol to fw-server:
 *   POST /v1/flags/evaluate    (batch — one call per context, not per key)
 *   POST /v1/capture
 *   POST /v1/targets/register
 *
 * Auth: `Authorization: Bearer <project key>`. Never a vendor key: the
 * constructor rejects `phc_`/`phs_`/`phx_` shapes outright (ADR-0009).
 *
 * Credentials are EXPLICIT constructor options. This package never reads
 * `import.meta.env`, `process.env`, or any other ambient source — the embedding
 * app decides what goes into its bundle, and the SDK never picks something up
 * on its own.
 *
 * See spec/remote-protocol.md § Browser clients.
 */
import { FireweaveError } from '../../domain/errors.js';
import { assertHostAllowed, assertNotSecretKey } from '../hosts.js';
import { validateTargetingKey } from '../../domain/validation.js';
import type {
  AdapterResolution,
  AdapterRuntimeFeatures,
  PrefetchOptions,
  PrefetchResult,
  RegisterTargetOptions,
  RegisterTargetResult,
  WebBackendAdapter,
} from '../../application/ports.js';
import type { CanonicalContext, DecisionReason, Exposure, JsonValue, Signal } from '../../domain/types.js';

const EVALUATE_PATH = '/v1/flags/evaluate';
const CAPTURE_PATH = '/v1/capture';
const REGISTER_TARGET_PATH = '/v1/targets/register';

const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;

export type FireweaveFetchLike = typeof fetch;

export interface FireweaveRemoteWebAdapterOptions {
  /** fw-server base URL, e.g. `https://app-server.fireweave.ai`. */
  readonly apiUrl: string;
  /** Fireweave project key. Public by construction — must be scoped accordingly. */
  readonly apiKey: string;
  /** SSRF/misconfiguration allowlist override. `['*']` opts out. */
  readonly allowedHosts?: readonly string[];
  readonly requestTimeoutMs?: number;
  /** Injected fetch (tests). Defaults to the global. */
  readonly fetch?: FireweaveFetchLike;
}

interface DecisionItem {
  flagKey: string;
  value: JsonValue;
  reason: string;
  found: boolean;
  enabled?: boolean;
  variant?: string | null;
  payload?: JsonValue;
  flagMetadata?: Record<string, string | number | boolean>;
}

interface EvaluateResponse {
  decisions?: DecisionItem[];
  quotaLimited?: boolean;
}

interface CaptureEvent {
  type: 'exposure' | 'signal' | 'event';
  targetingKey: string;
  name?: string;
  flagKey?: string;
  value?: JsonValue;
  variant?: string | null;
  timestamp?: string;
  rolloutId?: string;
  changeId?: string;
  stampId?: string;
  properties?: Record<string, JsonValue>;
}

const ALLOWED_REASONS: ReadonlySet<string> = new Set([
  'STATIC',
  'DEFAULT',
  'TARGETING_MATCH',
  'SPLIT',
  'CACHED',
  'STALE',
  'DISABLED',
  'UNKNOWN',
  'ERROR',
]);

function toReason(reason: string): DecisionReason | undefined {
  return ALLOWED_REASONS.has(reason) ? (reason as DecisionReason) : undefined;
}

function mapHttpStatus(status: number): FireweaveError {
  if (status === 401) return new FireweaveError('Authentication');
  if (status === 403) return new FireweaveError('Authorization');
  if (status === 429) return new FireweaveError('RateLimited');
  return new FireweaveError('BackendUnavailable');
}

export class FireweaveRemoteWebAdapter implements WebBackendAdapter {
  readonly name = 'fireweave' as const;

  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly allowedHosts: readonly string[] | undefined;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: FireweaveFetchLike;
  private readonly pending: CaptureEvent[] = [];
  private ready = false;
  private closed = false;

  constructor(options: FireweaveRemoteWebAdapterOptions) {
    // Validate at construction, not at first use: a misconfigured key should
    // fail where the developer can see it, not on a user's first evaluation.
    assertNotSecretKey(options.apiKey);
    this.apiUrl = options.apiUrl.trim().replace(/\/+$/, '');
    this.apiKey = options.apiKey.trim();
    this.allowedHosts = options.allowedHosts;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async initialize(_signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new FireweaveError('AlreadyClosed');
    if (this.apiUrl.length === 0) throw new FireweaveError('Configuration');
    assertHostAllowed(this.apiUrl, this.allowedHosts);
    this.ready = true;
  }

  async prefetch(context: CanonicalContext, options?: PrefetchOptions): Promise<PrefetchResult> {
    if (this.closed) throw new FireweaveError('AlreadyClosed');
    if (!this.ready) throw new FireweaveError('NotReady');

    const targetingKeyResult = validateTargetingKey(context.targetingKey, true);
    if (!targetingKeyResult.ok) throw targetingKeyResult.error;
    const targetingKey = targetingKeyResult.value ?? '';

    // `$`-prefixed and `fireweave.`-prefixed attributes are backend directives,
    // not person properties, and groups travel in their own fields.
    const attributes: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(context.attributes)) {
      if (k === 'groups' || k === 'groupProperties') continue;
      if (k.startsWith('$') || k.startsWith('fireweave.')) continue;
      attributes[k] = v;
    }

    const body: Record<string, unknown> = { targetingKey };
    if (Object.keys(attributes).length > 0) body['attributes'] = attributes;
    if (context.groups !== undefined) body['groups'] = context.groups;
    if (context.groupProperties !== undefined) body['groupProperties'] = context.groupProperties;
    if (options?.flagKeys !== undefined && options.flagKeys.length > 0) {
      body['flagKeys'] = options.flagKeys;
    }

    const response = await this.requestJson<EvaluateResponse>(
      EVALUATE_PATH,
      body,
      options?.signal
    );

    const out = new Map<string, AdapterResolution>();
    for (const item of response.decisions ?? []) {
      out.set(item.flagKey, this.toResolution(item, response.quotaLimited === true));
    }
    return out;
  }

  async registerTarget(
    targetingKey: string,
    options: RegisterTargetOptions = {}
  ): Promise<RegisterTargetResult> {
    if (this.closed) return { ok: false, error: new FireweaveError('AlreadyClosed') };
    if (!this.ready) return { ok: false, error: new FireweaveError('NotReady') };
    const targetingKeyResult = validateTargetingKey(targetingKey.trim() === '' ? undefined : targetingKey, true);
    if (!targetingKeyResult.ok) return { ok: false, error: targetingKeyResult.error };

    const body: Record<string, unknown> = { targetingKey };
    if (options.kind !== undefined) body['kind'] = options.kind;
    if (options.environment !== undefined) body['environment'] = options.environment;
    if (options.properties !== undefined && Object.keys(options.properties).length > 0) {
      body['properties'] = options.properties;
    }

    // Retried once, and only when the taxonomy says a retry could succeed: a
    // rejected payload or a bad key would be rejected identically.
    let lastError: FireweaveError | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.requestJson(REGISTER_TARGET_PATH, body, options.signal);
        return { ok: true };
      } catch (err) {
        lastError = err instanceof FireweaveError ? err : new FireweaveError('BackendUnavailable');
        if (!lastError.retryable) break;
      }
    }
    return { ok: false, ...(lastError !== undefined ? { error: lastError } : {}) };
  }

  recordExposure(exposure: Exposure): void {
    if (this.closed || !this.ready) return;
    const event: CaptureEvent = {
      type: 'exposure',
      targetingKey: exposure.targetingKey,
      flagKey: exposure.flagKey,
      value: exposure.value,
    };
    if (exposure.variant !== undefined) event.variant = exposure.variant;
    if (exposure.rolloutId !== undefined) event.rolloutId = exposure.rolloutId;
    if (exposure.changeId !== undefined) event.changeId = exposure.changeId;
    if (exposure.stampId !== undefined) event.stampId = exposure.stampId;
    this.pending.push(event);
  }

  recordSignal(signal: Signal): void {
    if (this.closed || !this.ready) return;
    const event: CaptureEvent = {
      type: 'signal',
      targetingKey: signal.targetingKey ?? signal.rolloutId ?? 'fireweave-web-sdk',
      name: signal.name,
      properties: {
        kind: signal.kind,
        ...(signal.status !== undefined ? { status: signal.status } : {}),
        ...(signal.errorKind !== undefined ? { errorKind: signal.errorKind } : {}),
        ...(signal.message !== undefined ? { message: signal.message } : {}),
        ...(signal.value !== undefined ? { value: signal.value } : {}),
      },
    };
    if (signal.flagKey !== undefined) event.flagKey = signal.flagKey;
    if (signal.variant !== undefined) event.variant = signal.variant;
    if (signal.rolloutId !== undefined) event.rolloutId = signal.rolloutId;
    if (signal.timestamp !== undefined) event.timestamp = signal.timestamp;
    this.pending.push(event);
  }

  /**
   * `beacon: true` is the unload path. It must not await anything the browser
   * will cancel, so it uses `sendBeacon` when available and a `keepalive`
   * fetch otherwise, and it never re-queues on failure — there is no later.
   */
  async flush(options: { beacon?: boolean } = {}): Promise<void> {
    if (this.closed || this.pending.length === 0) return;
    const batch = this.pending.splice(0, this.pending.length);
    const payload = JSON.stringify({ events: batch });

    if (options.beacon === true) {
      this.sendBeaconOrKeepalive(payload);
      return;
    }

    try {
      await this.requestJson(CAPTURE_PATH, { events: batch });
    } catch {
      // Never throw out of flush; re-queue so a later flush can retry.
      this.pending.unshift(...batch);
    }
  }

  private sendBeaconOrKeepalive(payload: string): void {
    const url = `${this.apiUrl}${CAPTURE_PATH}`;
    const nav = globalThis.navigator as Navigator | undefined;
    // sendBeacon cannot set an Authorization header, so it is only usable where
    // the server accepts the key another way. Prefer keepalive fetch, which
    // can, and fall back to a beacon only if fetch is unavailable.
    try {
      void this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: payload,
        keepalive: true,
      }).catch(() => undefined);
      return;
    } catch {
      // fall through to beacon
    }
    if (typeof nav?.sendBeacon === 'function') {
      try {
        nav.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
      } catch {
        // Unload-time delivery is best-effort by definition.
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
    this.ready = false;
  }

  features(): AdapterRuntimeFeatures {
    return {
      remoteEvaluation: true,
      // Structural, not configurable — the browser never evaluates locally.
      localEvaluation: false,
      localOnly: false,
      exposureEmission: true,
      sideEffectFreeReads: true,
      groupAnalytics: true,
    };
  }

  private toResolution(item: DecisionItem, quotaLimited: boolean): AdapterResolution {
    if (item.found === false) {
      return quotaLimited ? { found: false, quotaLimited: true } : { found: false };
    }
    const resolution: AdapterResolution = {
      found: true,
      value: item.value,
      enabled: item.enabled ?? true,
    };
    if (item.variant != null) resolution.variant = item.variant;
    const reason = toReason(item.reason);
    if (reason !== undefined) resolution.reason = reason;
    if (item.payload !== undefined) resolution.payload = item.payload;
    const meta = item.flagMetadata ?? {};
    if (typeof meta['fireweave.flagVersion'] === 'number') {
      resolution.version = meta['fireweave.flagVersion'];
    }
    if (typeof meta['fireweave.reasonCode'] === 'string') {
      resolution.reasonCode = meta['fireweave.reasonCode'];
    }
    if (quotaLimited || meta['fireweave.quotaLimited'] === true) resolution.quotaLimited = true;
    return resolution;
  }

  private async requestJson<T>(path: string, body: unknown, outerSignal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const onOuterAbort = () => controller.abort();
    if (outerSignal !== undefined) {
      if (outerSignal.aborted) controller.abort();
      else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    }
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.apiUrl}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        const aborted = err instanceof Error && err.name === 'AbortError';
        throw aborted ? new FireweaveError('Timeout') : new FireweaveError('Network');
      }
      if (response.status >= 400) throw mapHttpStatus(response.status);
      try {
        return (await response.json()) as T;
      } catch {
        throw new FireweaveError('MalformedResponse');
      }
    } finally {
      clearTimeout(timer);
      if (outerSignal !== undefined) outerSignal.removeEventListener('abort', onOuterAbort);
    }
  }
}
