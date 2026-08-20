/**
 * initFireweave — the single SDK entry point (spec/modes.md).
 *
 * `mode` is required and never inferred: a missing or mistyped credential
 * must fail loudly at boot, not silently fall back to local evaluation —
 * that failure mode looks like a green boot and a feature that never ramps.
 * This function's only job is to validate the initialisation-time contract
 * and select the matching adapter; nothing downstream branches on mode again
 * (spec/modes.md "Behaviour per mode" — both adapters implement the same
 * WebBackendAdapter port, so FireweaveWebClient / FireweaveWebRuntime stay
 * mode-blind).
 *
 * Initialisation fails loudly (throws); reads on the returned client never do
 * (spec/control-points.md "initialise is the exception").
 *
 * ## A web-specific wrinkle: `FireweaveWebRuntime.initialize()` never throws
 *
 * Node's `FireweaveRuntime.initialize()` rejects on adapter failure, so
 * node's initFireweave can just `await runtime.initialize()` and let a bad
 * host/credential propagate. Web's runtime is deliberately fail-OPEN at
 * `initialize()` — a hung or failing prefetch must not block app boot
 * (ADR-0009 "Fail-open, not fail-silent"), so it swallows adapter failures
 * into ERROR/STALE state instead of rejecting.
 *
 * That non-throwing contract is correct for TRANSIENT failures (the network
 * happened to be down) but wrong for the four Configuration rows below,
 * which spec/modes.md requires to fail loudly at boot. This module closes
 * that gap itself in two parts: `validateInitOptions` (domain/validation.ts)
 * covers rows 1/2/4 (mode absent/unrecognised, remote apiKey/apiUrl blank,
 * local combined with credentials) exactly like node's `initFireweave` does;
 * `initRemote` covers row 3 (the host allowlist) with a direct, SYNCHRONOUS
 * `assertHostAllowed` call, before ever calling into the runtime — that call
 * is what makes a bad host fail LOUDLY here, because the runtime itself
 * deliberately never throws. A genuinely transient prefetch failure (host is
 * fine, network hiccups) still resolves into ERROR/STALE rather than
 * throwing — that fail-open behaviour is unchanged and is not one of the
 * four rows.
 */
import { FireweaveWebClient } from './client.js';
import { FireweaveWebRuntime } from './runtime.js';
import { FireweaveLocalWebAdapter } from '../infrastructure/adapters/local.js';
import { FireweaveRemoteWebAdapter } from '../infrastructure/adapters/remote.js';
import type { FireweaveFetchLike } from '../infrastructure/adapters/remote.js';
import { assertHostAllowed } from '../infrastructure/hosts.js';
import { validateInitOptions } from '../domain/validation.js';
import type { ContextInput } from '../domain/context.js';

export interface InitFireweaveRemoteOptions {
  /** Evaluate against fw-server over the network (spec/remote-protocol.md). */
  readonly mode: 'remote';
  /** Fireweave project key. Public by construction (ADR-0009) — required, never read from the environment. */
  readonly apiKey: string;
  /** fw-server base URL. Required — never read from the environment. */
  readonly apiUrl: string;
  /**
   * SSRF/misconfiguration allowlist override (spec/modes.md "apiUrl fails
   * the host allowlist"). Default: the canonical Fireweave hosts + loopback
   * (`DEFAULT_ALLOWED_HOSTS`). A self-hosted fw-server must list its own
   * host explicitly; `['*']` opts out.
   */
  readonly allowedHosts?: readonly string[];
  /** Injected fetch (tests). Production uses the runtime's global `fetch`. */
  readonly fetch?: FireweaveFetchLike;
  /** Initial evaluation context (e.g. an anonymous targetingKey) to prefetch under. */
  readonly context?: ContextInput;
}

export interface InitFireweaveLocalOptions {
  /** Evaluate against an in-process seeded map; no network (spec/modes.md). */
  readonly mode: 'local';
  readonly local?: {
    /**
     * Per-key boolean overrides — the seeded local map. A present key
     * resolves with reason `STATIC`; an absent key misses so the caller's
     * own default is used. May be empty or omitted entirely.
     */
    readonly controlPoints?: Record<string, boolean>;
    /**
     * Sink for the `[fireweave:local]` registerTarget trace line
     * (spec/modes.md "registerTarget in local mode"). Defaults to
     * `console.info`.
     */
    readonly log?: (message: string) => void;
  };
  /** Initial evaluation context (e.g. an anonymous targetingKey) to prefetch under. */
  readonly context?: ContextInput;
}

export type InitFireweaveOptions = InitFireweaveRemoteOptions | InitFireweaveLocalOptions;

async function initLocal(options: InitFireweaveLocalOptions): Promise<FireweaveWebClient> {
  const local = options.local ?? {};
  const adapter = new FireweaveLocalWebAdapter({
    devFlags: local.controlPoints ?? {},
    ...(local.log !== undefined ? { log: local.log } : {}),
  });
  const runtime = new FireweaveWebRuntime(adapter);
  const client = new FireweaveWebClient(runtime);
  await client.initialize(options.context);
  return client;
}

async function initRemote(options: InitFireweaveRemoteOptions): Promise<FireweaveWebClient> {
  const { apiKey, apiUrl, allowedHosts, fetch } = options;
  // `validateInitOptions` (called by `initFireweave`, below) has already
  // ruled out blank apiKey/apiUrl by the time this runs — only the host
  // allowlist row remains to check here. See the module doc comment: this
  // call — not runtime.initialize() — is what makes a bad host fail LOUDLY
  // here, because the runtime itself deliberately never throws.
  assertHostAllowed(apiUrl, allowedHosts);

  const adapter = new FireweaveRemoteWebAdapter({
    apiUrl,
    apiKey,
    ...(allowedHosts !== undefined ? { allowedHosts } : {}),
    ...(fetch !== undefined ? { fetch } : {}),
  });
  const runtime = new FireweaveWebRuntime(adapter);
  const client = new FireweaveWebClient(runtime);
  await client.initialize(options.context);
  return client;
}

/**
 * Build the adapter matching `options.mode` and bring a
 * {@link FireweaveWebClient} up.
 *
 * Throws {@link FireweaveError} (kind `Configuration`) for every row of the
 * initialisation-validation table (spec/modes.md):
 *  - `mode` absent or unrecognised
 *  - `mode: 'remote'` with `apiKey` or `apiUrl` missing/blank
 *  - `apiUrl` fails the host allowlist
 *  - `mode: 'local'` with credentials supplied
 *
 * The first, second and fourth rows are `validateInitOptions`'s job
 * (domain/validation.ts, shared discipline with node's `initFireweave`); the
 * third is validated downstream, inside `initRemote`, for the reason the
 * module doc comment explains — `FireweaveWebRuntime.initialize()` itself
 * never throws.
 */
export async function initFireweave(options: InitFireweaveOptions): Promise<FireweaveWebClient> {
  const validated = validateInitOptions(options);
  if (!validated.ok) throw validated.error;
  const validOptions = validated.value;
  return validOptions.mode === 'local' ? initLocal(validOptions) : initRemote(validOptions);
}
