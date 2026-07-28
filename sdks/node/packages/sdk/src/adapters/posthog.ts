/**
 * PostHog backend adapter (ADR-0002). Wraps posthog-node@5.46.x behind the
 * canonical BackendAdapter boundary:
 *  - evaluateFlags() snapshot API only (no deprecated per-flag calls);
 *  - remote mode with a phc_ project key; local-eval / hybrid mode when a
 *    secret (phs_/phx_) key is supplied;
 *  - injected-vs-owned client lifecycle (injected clients are never shut down);
 *  - exposure policy: side-effect-free reads — local snapshot values are taken
 *    from internal `_flags` records (never `getFlag`/`isEnabled`, which emit
 *    vendor `$feature_flag_called`); owned clients also gate capture so stray
 *    vendor exposures without `fireweave.exposure` are dropped. Fireweave
 *    exposures flow only through {@link PostHogAdapter.recordExposure};
 *  - quotaLimited ⇒ FlagNotFound default + fireweave.quotaLimited metadata;
 *  - error mapping via an injected fetch observer, because posthog-node
 *    swallows /flags transport errors and returns empty snapshots.
 *  - hybrid local serve (secret key, no /flags observation) returns a Decision
 *    from the local snapshot — never maps success to Network (RB-1).
 *
 * No posthog-node types appear in this module's exported (public) API surface —
 * the client is accepted via the structural {@link PostHogClientLike} interface.
 */
import { FireweaveError } from '../errors.js';
import { assertHostAllowed } from '../hosts.js';
import type {
  AdapterResolution,
  AdapterRuntimeFeatures,
  BackendAdapter,
  ResolveOptions,
} from '../adapter.js';
import type { CanonicalContext, Exposure, JsonValue, Signal } from '../types.js';

/** Default bound on client shutdown (mirrors DEFAULT_SHUTDOWN_TIMEOUT_MS). */
const DEFAULT_ADAPTER_SHUTDOWN_TIMEOUT_MS = 10000;

/** Internal per-flag record shape (mirrors posthog-node EvaluatedFlagRecord). */
export interface SnapshotFlagRecord {
  key: string;
  enabled: boolean;
  variant?: string | null | undefined;
  payload?: unknown;
  id?: number | null | undefined;
  version?: number | null | undefined;
  reason?: string | null | undefined;
  locallyEvaluated?: boolean | undefined;
}

/** Snapshot returned by evaluateFlags — prefer `_flags` for side-effect-free reads. */
export interface EvaluateFlagsSnapshot {
  isEnabled(key: string): boolean;
  getFlag(key: string): string | boolean | undefined;
  getFlagPayload(key: string): unknown;
  keys: string[];
  /**
   * Internal flag records. Reading these does not emit `$feature_flag_called`
   * (unlike `getFlag` / `isEnabled`). Real posthog-node snapshots expose this;
   * test fakes should too when exercising the local path.
   */
  _flags?: Record<string, SnapshotFlagRecord>;
}

/** Minimal structural view of a posthog-node client (no vendor types leaked). */
export interface PostHogClientLike {
  evaluateFlags(distinctId: string, options?: {
    groups?: Record<string, string>;
    personProperties?: Record<string, string>;
    groupProperties?: Record<string, Record<string, string>>;
    onlyEvaluateLocally?: boolean;
    disableGeoip?: boolean;
    flagKeys?: string[];
  }): Promise<EvaluateFlagsSnapshot>;
  capture(props: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
  }): void;
  waitForLocalEvaluationReady?(timeoutMs?: number): Promise<boolean>;
  isLocalEvaluationReady?(): boolean;
  flush(): Promise<void>;
  shutdown(shutdownTimeoutMs?: number): Promise<void>;
}

type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
}) => Promise<{
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
  headers: { get(name: string): string | null };
}>;

export interface PostHogAdapterOptions {
  /** PostHog project API key (phc_...). Required unless a client is injected. */
  projectApiKey?: string;
  /** PostHog host (e.g. the test-server stub or us.i.posthog.com). */
  host?: string;
  /**
   * SSRF allowlist override. Empty/undefined ⇒ the canonical PostHog default
   * allowlist + loopback; ['*'] opts out (self-hosted at your own risk).
   */
  allowedHosts?: readonly string[];
  /** Deadline handed to the vendor client's shutdown (default 10 000 ms). */
  shutdownTimeoutMs?: number;
  /** Secret/personal key (phs_/phx_) enabling local evaluation. */
  secretApiKey?: string;
  /** Evaluate exclusively from local definitions (no /flags fallback). */
  onlyEvaluateLocally?: boolean;
  /** Timeout for /flags requests. */
  featureFlagsRequestTimeoutMs?: number;
  /** Definitions polling interval (local eval). */
  featureFlagsPollingInterval?: number;
  /** Injected client (tests / shared client). Lifecycle stays with the caller. */
  client?: PostHogClientLike;
  /** Base fetch used under the observer (tests may stub the network here). */
  fetch?: FetchLike;
  /** Wait for the first definitions poll during initialize() (local eval). */
  waitForLocalDefinitions?: boolean;
}

interface FlagsObservation {
  kind: 'ok' | 'http' | 'network' | 'abort' | 'parse';
  status?: number;
  body?: FlagsV2Body;
}

interface FlagsV2Flag {
  key: string;
  enabled: boolean;
  variant: string | null;
  reason?: { code?: string; condition_index?: number | null; description?: string } | null;
  metadata?: { id?: number | null; version?: number | null; payload?: string | null } | null;
}

interface FlagsV2Body {
  flags?: Record<string, FlagsV2Flag>;
  errorsWhileComputingFlags?: boolean;
  requestId?: string;
  quotaLimited?: string[] | null;
}

function mapHttpStatus(status: number): FireweaveError {
  if (status === 401) return new FireweaveError('Authentication');
  if (status === 403) return new FireweaveError('Authorization');
  if (status === 429) return new FireweaveError('RateLimited');
  if (status >= 500) return new FireweaveError('BackendUnavailable');
  return new FireweaveError('BackendUnavailable');
}

export class PostHogAdapter implements BackendAdapter {
  readonly name = 'posthog' as const;
  private readonly options: PostHogAdapterOptions;
  private client: PostHogClientLike | undefined;
  private readonly ownsClient: boolean;
  private closed = false;
  /** Last /flags observation per distinct_id. */
  private readonly flagsObservations = new Map<string, FlagsObservation>();
  /** Local-eval definitions state (driven by the fetch observer). */
  private definitionsLoaded = false;
  private definitionsStale = false;

  constructor(options: PostHogAdapterOptions = {}) {
    this.options = { ...options };
    this.ownsClient = options.client === undefined;
    if (options.client !== undefined) {
      this.client = options.client;
    }
  }

  /** The fetch implementation handed to posthog-node: observes every request. */
  private buildObservedFetch(): FetchLike {
    const base: FetchLike = this.options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    return async (url, init) => {
      const isFlags = url.includes('/flags') && !url.includes('/flags/definitions');
      const isDefinitions = url.includes('/flags/definitions');
      let distinctId: string | undefined;
      if (isFlags && typeof init?.body === 'string') {
        try {
          const parsed = JSON.parse(init.body) as { distinct_id?: string };
          distinctId = parsed.distinct_id;
        } catch {
          // ignore unparseable request bodies
        }
      }
      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await base(url, init);
      } catch (err) {
        if (isFlags && distinctId !== undefined) {
          const aborted = err instanceof Error && err.name === 'AbortError';
          this.flagsObservations.set(distinctId, { kind: aborted ? 'abort' : 'network' });
        }
        if (isDefinitions && this.definitionsLoaded) this.definitionsStale = true;
        throw err;
      }
      if (isDefinitions) {
        if (response.status === 200) {
          this.definitionsLoaded = true;
          this.definitionsStale = false;
        } else if (response.status !== 304 && this.definitionsLoaded) {
          this.definitionsStale = true;
        }
        return response;
      }
      if (!isFlags || distinctId === undefined) return response;

      // Buffer the body so both we and posthog-node can read it.
      let text: string;
      try {
        text = await response.text();
      } catch {
        this.flagsObservations.set(distinctId, { kind: 'network' });
        throw new Error('response body read failed');
      }
      if (response.status >= 400) {
        this.flagsObservations.set(distinctId, { kind: 'http', status: response.status });
      } else {
        try {
          const body = JSON.parse(text) as FlagsV2Body;
          this.flagsObservations.set(distinctId, { kind: 'ok', status: response.status, body });
        } catch {
          this.flagsObservations.set(distinctId, { kind: 'parse', status: response.status });
        }
      }
      const buffered = {
        status: response.status,
        headers: response.headers,
        text: async () => text,
        json: async () => JSON.parse(text) as unknown,
      };
      return buffered as Awaited<ReturnType<FetchLike>>;
    };
  }

  async initialize(_signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new FireweaveError('AlreadyClosed');
    if (this.client === undefined) {
      if (this.options.projectApiKey === undefined || this.options.projectApiKey.length === 0) {
        throw new FireweaveError('Configuration');
      }
      // Default-on host allowlist (H-1): the adapter is the egress point, so
      // it validates independently of the runtime-level config check.
      if (this.options.host !== undefined) {
        assertHostAllowed(this.options.host, this.options.allowedHosts);
      }
      // posthog-node is an optional peer dependency: load lazily so the main
      // entrypoint never depends on it.
      const mod = (await import('posthog-node')) as {
        PostHog: new (apiKey: string, options?: Record<string, unknown>) => unknown;
      };
      const clientOptions: Record<string, unknown> = {
        host: this.options.host,
        fetch: this.buildObservedFetch(),
        featureFlagsRequestMaxRetries: 0,
        fetchRetryCount: 0,
        flushAt: 100,
        disableCompression: true,
        // Belt-and-suspenders for non-snapshot APIs. Snapshot getFlag/isEnabled
        // still emit unless we read `_flags` (RB-2) — see fromSnapshot + gate.
        sendFeatureFlagEvent: false,
      };
      if (this.options.featureFlagsRequestTimeoutMs !== undefined) {
        clientOptions['featureFlagsRequestTimeoutMs'] = this.options.featureFlagsRequestTimeoutMs;
      }
      if (this.options.secretApiKey !== undefined) {
        clientOptions['personalApiKey'] = this.options.secretApiKey;
        clientOptions['enableLocalEvaluation'] = true;
        if (this.options.featureFlagsPollingInterval !== undefined) {
          clientOptions['featureFlagsPollingInterval'] = this.options.featureFlagsPollingInterval;
        }
      }
      const owned = new mod.PostHog(this.options.projectApiKey, clientOptions) as unknown as PostHogClientLike;
      // Drop vendor auto-exposures that lack Fireweave's arming marker. Explicit
      // recordExposure() sets fireweave.exposure=true so those still flow.
      this.client = this.gateVendorExposureCapture(owned);
    }
    if (this.options.waitForLocalDefinitions === true && this.client.waitForLocalEvaluationReady !== undefined) {
      const ready = await this.client.waitForLocalEvaluationReady(5000);
      if (!ready) throw new FireweaveError('NotReady');
    }
  }

  async resolve(flagKey: string, context: CanonicalContext, _options?: ResolveOptions): Promise<AdapterResolution> {
    if (this.closed) throw new FireweaveError('AlreadyClosed');
    if (this.client === undefined) throw new FireweaveError('NotReady');
    const distinctId = context.targetingKey ?? '';
    if (distinctId === '') {
      throw new FireweaveError('InvalidContext', {
        message: 'targeting key missing',
        openFeatureErrorCode: 'TARGETING_KEY_MISSING',
      });
    }

    const localOnly = this.options.onlyEvaluateLocally === true;
    if (localOnly && this.client.isLocalEvaluationReady !== undefined && !this.client.isLocalEvaluationReady()) {
      throw new FireweaveError('NotReady');
    }

    const personProperties: Record<string, string> = {};
    for (const [k, v] of Object.entries(context.attributes)) {
      // groups/groupProperties (plain aliases), fireweave.* carriers (ruling 13)
      // and $-prefixed system directives are not person properties.
      if (k === 'groups' || k === 'groupProperties' || k.startsWith('$') || k.startsWith('fireweave.')) {
        continue;
      }
      personProperties[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    const groupProperties = this.extractGroupProperties(
      context.groupProperties ?? context.attributes['groupProperties'],
    );

    this.flagsObservations.delete(distinctId);
    const evalOptions: Parameters<PostHogClientLike['evaluateFlags']>[1] = {
      flagKeys: [flagKey],
      personProperties,
      disableGeoip: true,
    };
    if (context.groups !== undefined) evalOptions.groups = context.groups;
    if (groupProperties !== undefined) evalOptions.groupProperties = groupProperties;
    if (localOnly) evalOptions.onlyEvaluateLocally = true;

    const snapshot = await this.client.evaluateFlags(distinctId, evalOptions);
    const observation = this.flagsObservations.get(distinctId);

    if (!localOnly) {
      if (observation === undefined) {
        // RB-1: hybrid/local mode with a secret key (or definitions already
        // loaded) can satisfy evaluateFlags from the definitions poller without
        // hitting /flags. That is a successful local serve — not Network.
        if (this.canServeFromLocalSnapshot()) {
          return this.fromSnapshot(flagKey, snapshot);
        }
        // Remote-only (no secret / no definitions): missing observation means
        // the transport never reached /flags (offline).
        throw new FireweaveError('Network');
      }
      switch (observation.kind) {
        case 'abort':
          throw new FireweaveError('Timeout');
        case 'network':
          throw new FireweaveError('Network');
        case 'http':
          throw mapHttpStatus(observation.status ?? 0);
        case 'parse':
          throw new FireweaveError('MalformedResponse');
        case 'ok':
          return this.fromFlagsBody(flagKey, observation.body ?? {});
      }
    }

    // Local-only evaluation path: read from the snapshot without vendor emit.
    return this.fromSnapshot(flagKey, snapshot);
  }

  /** True when local definitions can satisfy a resolve without a /flags round-trip. */
  private canServeFromLocalSnapshot(): boolean {
    if (this.options.secretApiKey !== undefined) return true;
    if (this.definitionsLoaded) return true;
    if (this.client?.isLocalEvaluationReady?.() === true) return true;
    return false;
  }

  /**
   * Wrap an owned posthog-node client so vendor `$feature_flag_called` events
   * without Fireweave's arming marker are dropped (Go exposure-gate pattern).
   */
  private gateVendorExposureCapture(client: PostHogClientLike): PostHogClientLike {
    const rawCapture = client.capture.bind(client);
    client.capture = (props) => {
      if (
        props.event === '$feature_flag_called' &&
        props.properties?.['fireweave.exposure'] !== true
      ) {
        return;
      }
      rawCapture(props);
    };
    return client;
  }

  private fromFlagsBody(flagKey: string, body: FlagsV2Body): AdapterResolution {
    const quotaLimited = Array.isArray(body.quotaLimited) && body.quotaLimited.includes('feature_flags');
    const record = body.flags?.[flagKey];
    if (record === undefined) {
      const missing: AdapterResolution = { found: false };
      if (quotaLimited) missing.quotaLimited = true;
      return missing;
    }
    const variant = record.variant ?? undefined;
    const value: JsonValue = record.enabled ? (variant ?? true) : false;
    const resolution: AdapterResolution = {
      found: true,
      enabled: record.enabled,
      value,
    };
    if (variant !== undefined) resolution.variant = variant;
    if (record.reason?.code !== undefined) resolution.reasonCode = record.reason.code;
    if (record.reason?.condition_index !== undefined && record.reason.condition_index !== null) {
      resolution.conditionIndex = record.reason.condition_index;
    }
    if (record.metadata?.version !== undefined && record.metadata.version !== null) {
      resolution.version = record.metadata.version;
    }
    if (record.metadata?.id !== undefined && record.metadata.id !== null) {
      resolution.vendorFlagId = record.metadata.id;
    }
    if (record.metadata?.payload !== undefined && record.metadata.payload !== null) {
      resolution.payload = record.metadata.payload;
    }
    if (quotaLimited) resolution.quotaLimited = true;
    return resolution;
  }

  /**
   * Read a local/hybrid snapshot without calling getFlag/isEnabled (RB-2).
   * Those accessors unconditionally emit `$feature_flag_called` in posthog-node
   * and do not honor sendFeatureFlagEvent. Mirror Python: use `_flags` records.
   */
  private fromSnapshot(
    flagKey: string,
    snapshot: EvaluateFlagsSnapshot,
  ): AdapterResolution {
    const records = snapshot._flags;
    if (records === undefined) {
      // Structural fakes without `_flags` cannot be read side-effect-free.
      // Prefer missing over calling getFlag (which would emit vendor exposure).
      return { found: false };
    }
    const record = records[flagKey];
    if (record === undefined) return { found: false };
    const variant = record.variant ?? undefined;
    const variantStr = typeof variant === 'string' ? variant : undefined;
    const enabled = record.enabled;
    const resolution: AdapterResolution = {
      found: true,
      enabled,
      value: enabled ? (variantStr ?? true) : false,
    };
    if (variantStr !== undefined) resolution.variant = variantStr;
    if (record.reason !== undefined && record.reason !== null) {
      resolution.reasonCode = record.reason;
    }
    if (record.version !== undefined && record.version !== null) {
      resolution.version = record.version;
    }
    if (record.id !== undefined && record.id !== null) {
      resolution.vendorFlagId = record.id;
    }
    if (record.payload !== undefined && record.payload !== null) {
      resolution.payload = record.payload as JsonValue;
    } else {
      // getFlagPayload does not emit; safe enrichment when `_flags` omits payload.
      const payload = snapshot.getFlagPayload(flagKey);
      if (payload !== undefined && payload !== null) resolution.payload = payload as JsonValue;
    }
    if (this.definitionsStale) resolution.fromCache = true;
    return resolution;
  }

  private extractGroupProperties(
    value: Record<string, JsonValue> | JsonValue | undefined,
  ): Record<string, Record<string, string>> | undefined {
    if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out: Record<string, Record<string, string>> = {};
    for (const [group, props] of Object.entries(value)) {
      if (props === null || typeof props !== 'object' || Array.isArray(props)) continue;
      const groupOut: Record<string, string> = {};
      for (const [k, v] of Object.entries(props)) {
        groupOut[k] = typeof v === 'string' ? v : JSON.stringify(v);
      }
      out[group] = groupOut;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  recordExposure(exposure: Exposure): void {
    if (this.client === undefined || this.closed) return;
    const properties: Record<string, unknown> = {
      $feature_flag: exposure.flagKey,
      $feature_flag_response: exposure.variant ?? exposure.value,
      'fireweave.exposure': true,
    };
    if (exposure.rolloutId !== undefined) properties['fireweave.rolloutId'] = exposure.rolloutId;
    if (exposure.changeId !== undefined) properties['fireweave.changeId'] = exposure.changeId;
    if (exposure.stampId !== undefined) properties['fireweave.stampId'] = exposure.stampId;
    this.client.capture({
      distinctId: exposure.targetingKey,
      event: '$feature_flag_called',
      properties,
    });
  }

  async flush(): Promise<void> {
    if (this.client === undefined || this.closed) return;
    try {
      await this.client.flush();
    } catch {
      // flush failures must not throw into shutdown paths
    }
  }

  recordSignal(signal: Signal): void {
    if (this.client === undefined || this.closed) return;
    const properties: Record<string, unknown> = {
      'fireweave.signal': true,
      kind: signal.kind,
      name: signal.name,
    };
    if (signal.status !== undefined) properties['status'] = signal.status;
    if (signal.errorKind !== undefined) properties['errorKind'] = signal.errorKind;
    if (signal.message !== undefined) properties['message'] = signal.message;
    if (signal.value !== undefined) properties['value'] = signal.value;
    if (signal.rolloutId !== undefined) properties['fireweave.rolloutId'] = signal.rolloutId;
    if (signal.changeId !== undefined) properties['fireweave.changeId'] = signal.changeId;
    if (signal.stampId !== undefined) properties['fireweave.stampId'] = signal.stampId;
    if (signal.flagKey !== undefined) properties['flagKey'] = signal.flagKey;
    if (signal.variant !== undefined) properties['variant'] = signal.variant;
    this.client.capture({
      distinctId: signal.targetingKey ?? signal.rolloutId ?? 'fireweave-sdk',
      event: `$fw_signal_${signal.kind}`,
      properties,
    });
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.client !== undefined && this.ownsClient) {
      try {
        // Configured deadline (M-1/L-4): no more hardcoded 2 s — the vendor
        // client gets the same bound the config/capabilities advertise.
        await this.client.shutdown(this.options.shutdownTimeoutMs ?? DEFAULT_ADAPTER_SHUTDOWN_TIMEOUT_MS);
      } catch {
        // never throw from shutdown
      }
    }
  }

  isDefinitionsStale(): boolean {
    return this.definitionsStale;
  }

  features(): AdapterRuntimeFeatures {
    const local = this.options.secretApiKey !== undefined;
    return {
      remoteEvaluation: !(this.options.onlyEvaluateLocally === true),
      localEvaluation: local,
      localOnly: this.options.onlyEvaluateLocally === true,
      exposureEmission: true,
      sideEffectFreeReads: true,
      groupAnalytics: true,
    };
  }
}
