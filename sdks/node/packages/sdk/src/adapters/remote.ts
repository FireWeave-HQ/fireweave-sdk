/**
 * Fireweave remote backend adapter (ADR-0005) — **default production path**.
 *
 * Speaks only the vendor-neutral Fireweave remote protocol to fw-server:
 *   POST /v1/flags/evaluate
 *   POST /v1/capture
 *   POST /v1/targets/register
 *
 * Auth: Authorization: Bearer <FW_PROJECT_API_KEY> (project-api-key_…).
 * Which backend fw-server forwards to is fw-server's concern: no vendor SDK,
 * key, or host ever enters the application process.
 *
 * See spec/remote-protocol.md.
 */
import { readEnv } from '../env.js';
import { FireweaveError } from '../errors.js';
import { assertHostAllowed, isLoopbackHostname } from '../hosts.js';
import { validateTargetingKey } from '../validation.js';
import type {
  AdapterResolution,
  AdapterRuntimeFeatures,
  BackendAdapter,
  RegisterTargetOptions,
  RegisterTargetResult,
  ResolveOptions,
} from '../adapter.js';
import type { CanonicalContext, Exposure, JsonValue, Signal } from '../types.js';

const DEFAULT_ADAPTER_SHUTDOWN_TIMEOUT_MS = 10000;
const DEFAULT_REQUEST_TIMEOUT_MS = 3000;
const EVALUATE_PATH = '/v1/flags/evaluate';
const CAPTURE_PATH = '/v1/capture';
const REGISTER_TARGET_PATH = '/v1/targets/register';

type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export interface FireweaveRemoteAdapterOptions {
  /**
   * fw-server base URL (e.g. https://fw.example.com or http://127.0.0.1:3901).
   * Env alias: FW_API_URL.
   */
  apiUrl?: string;
  /**
   * Fireweave project/runtime key (project-api-key_…).
   * Env alias: FW_PROJECT_API_KEY.
   */
  apiKey?: string;
  /**
   * SSRF allowlist override. Default: hostname of `apiUrl` + loopback.
   * Pass `['*']` to opt out of host pinning.
   */
  allowedHosts?: readonly string[];
  /** Per-request timeout for evaluate/capture (default 3000 ms). */
  requestTimeoutMs?: number;
  /** Deadline for flush during shutdown (default 10 000 ms). */
  shutdownTimeoutMs?: number;
  /** Injected fetch (tests). */
  fetch?: FetchLike;
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
  requestId?: string;
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

function mapHttpStatus(status: number): FireweaveError {
  if (status === 401) return new FireweaveError('Authentication');
  if (status === 403) return new FireweaveError('Authorization');
  if (status === 429) return new FireweaveError('RateLimited');
  if (status >= 500) return new FireweaveError('BackendUnavailable');
  return new FireweaveError('BackendUnavailable');
}

function resolveFromEnv(options: FireweaveRemoteAdapterOptions): {
  apiUrl: string;
  apiKey: string;
} {
  const apiUrl = (options.apiUrl ?? readEnv('FW_API_URL') ?? '').replace(/\/+$/, '');
  const apiKey = options.apiKey ?? readEnv('FW_PROJECT_API_KEY') ?? '';
  return { apiUrl, apiKey };
}

function defaultAllowedHostsFor(apiUrl: string): string[] {
  try {
    const hostname = new URL(apiUrl).hostname;
    const hosts = [hostname, 'localhost', '127.0.0.1', '::1'];
    if (hostname === '[::1]') hosts.push('::1');
    return hosts;
  } catch {
    return ['localhost', '127.0.0.1', '::1'];
  }
}

function reasonToAdapter(reason: string): AdapterResolution['reason'] | undefined {
  const allowed = new Set([
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
  return allowed.has(reason) ? (reason as AdapterResolution['reason']) : undefined;
}

export class FireweaveRemoteAdapter implements BackendAdapter {
  readonly name = 'fireweave' as const;
  private readonly options: FireweaveRemoteAdapterOptions;
  private apiUrl = '';
  private apiKey = '';
  private closed = false;
  private ready = false;
  private readonly pending: CaptureEvent[] = [];
  private readonly fetchImpl: FetchLike;

  constructor(options: FireweaveRemoteAdapterOptions = {}) {
    this.options = { ...options };
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  async initialize(_signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new FireweaveError('AlreadyClosed');
    const { apiUrl, apiKey } = resolveFromEnv(this.options);
    if (!apiUrl || !apiKey) {
      throw new FireweaveError('Configuration');
    }
    let url: URL;
    try {
      url = new URL(apiUrl);
    } catch {
      throw new FireweaveError('Configuration');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new FireweaveError('Configuration');
    }
    if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
      throw new FireweaveError('Configuration');
    }
    const allow =
      this.options.allowedHosts !== undefined && this.options.allowedHosts.length > 0
        ? this.options.allowedHosts
        : defaultAllowedHostsFor(apiUrl);
    assertHostAllowed(apiUrl, allow);
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.ready = true;
  }

  async resolve(
    flagKey: string,
    context: CanonicalContext,
    options?: ResolveOptions,
  ): Promise<AdapterResolution> {
    if (this.closed) throw new FireweaveError('AlreadyClosed');
    if (!this.ready) throw new FireweaveError('NotReady');
    const targetingKeyResult = validateTargetingKey(context.targetingKey, true);
    if (!targetingKeyResult.ok) throw targetingKeyResult.error;
    const targetingKey = targetingKeyResult.value ?? '';

    const attributes: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(context.attributes)) {
      if (k === 'groups' || k === 'groupProperties' || k.startsWith('$') || k.startsWith('fireweave.')) {
        continue;
      }
      attributes[k] = v;
    }

    const body: Record<string, unknown> = {
      targetingKey,
      flagKeys: [flagKey],
    };
    if (Object.keys(attributes).length > 0) body['attributes'] = attributes;
    if (context.groups !== undefined) body['groups'] = context.groups;
    if (context.groupProperties !== undefined) body['groupProperties'] = context.groupProperties;

    const response = await this.requestJson<EvaluateResponse>(
      EVALUATE_PATH,
      body,
      options?.signal,
    );
    const item = response.decisions?.find((d) => d.flagKey === flagKey);
    if (item === undefined) {
      const missing: AdapterResolution = { found: false };
      if (response.quotaLimited === true) missing.quotaLimited = true;
      return missing;
    }
    return this.toResolution(item, response.quotaLimited === true);
  }

  /**
   * Register a user or device so flag rules can target its DURABLE properties.
   *
   * Call once per login / device provisioning, then send the same
   * `targetingKey` on evaluate. Per-request `attributes` still override the
   * stored properties for a single evaluation — the two identity paths compose
   * (see spec/remote-protocol.md § Two identity paths).
   *
   * Never throws for transport failures: registration sits in login paths, and
   * an analytics call must not break sign-in. Retried ONCE when the error
   * taxonomy marks the failure retryable (network / timeout / backend); a
   * rejected payload or bad key is not retried, since it would be rejected
   * identically. The result object reports what happened for callers that
   * want to log it.
   */
  async registerTarget(
    targetingKey: string,
    options: RegisterTargetOptions = {},
  ): Promise<RegisterTargetResult> {
    if (this.closed) return { ok: false, error: new FireweaveError('AlreadyClosed') };
    if (!this.ready) return { ok: false, error: new FireweaveError('NotReady') };
    const targetingKeyResult = validateTargetingKey(targetingKey, true);
    if (!targetingKeyResult.ok) return { ok: false, error: targetingKeyResult.error };

    const body: Record<string, unknown> = { targetingKey };
    if (options.kind !== undefined) body['kind'] = options.kind;
    if (options.environment !== undefined) body['environment'] = options.environment;
    if (options.properties !== undefined && Object.keys(options.properties).length > 0) {
      body['properties'] = options.properties;
    }

    let lastError: FireweaveError | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.requestJson(REGISTER_TARGET_PATH, body, options.signal);
        return { ok: true };
      } catch (err) {
        lastError =
          err instanceof FireweaveError ? err : new FireweaveError('BackendUnavailable');
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
      targetingKey: signal.targetingKey ?? signal.rolloutId ?? 'fireweave-sdk',
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
    if (signal.changeId !== undefined) event.changeId = signal.changeId;
    if (signal.stampId !== undefined) event.stampId = signal.stampId;
    if (signal.timestamp !== undefined) event.timestamp = signal.timestamp;
    this.pending.push(event);
  }

  async flush(): Promise<void> {
    if (this.closed || !this.ready || this.pending.length === 0) return;
    const batch = this.pending.splice(0, this.pending.length);
    try {
      await this.requestJson(CAPTURE_PATH, { events: batch });
    } catch {
      // flush failures must not throw into shutdown paths; re-queue best-effort
      this.pending.unshift(...batch);
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      const timeout = this.options.shutdownTimeoutMs ?? DEFAULT_ADAPTER_SHUTDOWN_TIMEOUT_MS;
      await Promise.race([
        this.flush(),
        new Promise<void>((resolve) => setTimeout(resolve, timeout)),
      ]);
    } catch {
      // never throw from shutdown
    }
    this.ready = false;
  }

  features(): AdapterRuntimeFeatures {
    return {
      remoteEvaluation: true,
      localEvaluation: false,
      localOnly: false,
      exposureEmission: true,
      sideEffectFreeReads: true,
      groupAnalytics: true,
    };
  }

  private toResolution(item: DecisionItem, quotaLimited: boolean): AdapterResolution {
    if (item.found === false) {
      const missing: AdapterResolution = { found: false };
      if (quotaLimited) missing.quotaLimited = true;
      return missing;
    }
    const resolution: AdapterResolution = {
      found: true,
      value: item.value,
      enabled: item.enabled ?? true,
    };
    if (item.variant != null) resolution.variant = item.variant;
    const reason = reasonToAdapter(item.reason);
    if (reason !== undefined) resolution.reason = reason;
    if (item.payload !== undefined) resolution.payload = item.payload;
    const meta = item.flagMetadata ?? {};
    if (typeof meta['fireweave.flagVersion'] === 'number') {
      resolution.version = meta['fireweave.flagVersion'];
    }
    if (typeof meta['fireweave.vendorFlagId'] === 'number') {
      resolution.vendorFlagId = meta['fireweave.vendorFlagId'];
    }
    if (typeof meta['fireweave.reasonCode'] === 'string') {
      resolution.reasonCode = meta['fireweave.reasonCode'];
    }
    if (quotaLimited || meta['fireweave.quotaLimited'] === true) {
      resolution.quotaLimited = true;
    }
    return resolution;
  }

  private async requestJson<T>(
    path: string,
    body: unknown,
    outerSignal?: AbortSignal,
  ): Promise<T> {
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = () => controller.abort();
    if (outerSignal !== undefined) {
      if (outerSignal.aborted) controller.abort();
      else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    }
    try {
      let response: Awaited<ReturnType<FetchLike>>;
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
      if (response.status >= 400) {
        throw mapHttpStatus(response.status);
      }
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new FireweaveError('MalformedResponse');
      }
      return parsed as T;
    } finally {
      clearTimeout(timer);
      if (outerSignal !== undefined) {
        outerSignal.removeEventListener('abort', onOuterAbort);
      }
    }
  }
}
