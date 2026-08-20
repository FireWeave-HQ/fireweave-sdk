/**
 * initFireweave — the single SDK entry point (spec/modes.md).
 *
 * `mode` is required and never inferred: a missing or mistyped credential
 * must fail loudly at boot, not silently fall back to local evaluation —
 * that failure mode looks like a green boot and a feature that never ramps.
 * This function's only job is to validate the initialisation-time contract
 * and select the matching adapter; nothing downstream branches on mode again
 * (spec/modes.md "Behaviour per mode" — both adapters implement the same
 * BackendAdapter port, so FireweaveClient / FireweaveRuntime stay mode-blind).
 *
 * Initialisation fails loudly (throws); reads on the returned client never do
 * (spec/control-points.md "initialise is the exception"). The validation
 * itself lives in `validateInitOptions` (validation.ts), which returns
 * `Validated<T>` like every other validator — this function is what converts
 * a failed `Validated` into the throw spec/modes.md requires.
 */
import { FireweaveClient } from './client.js';
import { FireweaveRuntime } from './runtime.js';
import { FireweaveLocalAdapter } from '../infrastructure/adapters/local.js';
import { FireweaveRemoteAdapter } from '../infrastructure/adapters/remote.js';
import type { FireweaveRemoteAdapterOptions } from '../infrastructure/adapters/remote.js';
import { validateInitOptions } from '../domain/validation.js';

export interface InitFireweaveRemoteOptions {
  /** Evaluate against fw-server over the network (spec/remote-protocol.md). */
  readonly mode: 'remote';
  /** Fireweave project/runtime key (project-api-key_…). Required — never read from env. */
  readonly apiKey: string;
  /** fw-server base URL. Required — never read from env. */
  readonly apiUrl: string;
  /**
   * SSRF allowlist override (spec/modes.md "apiUrl fails the host allowlist").
   * Default: the canonical Fireweave hosts + loopback (`DEFAULT_ALLOWED_HOSTS`).
   * A self-hosted fw-server must list its own host explicitly; `['*']` opts out.
   */
  readonly allowedHosts?: readonly string[];
  /** Injected transport (tests). Production uses the runtime's global `fetch`. */
  readonly fetch?: FireweaveRemoteAdapterOptions['fetch'];
}

export interface InitFireweaveLocalOptions {
  /** Evaluate against an in-process seeded map; no network (spec/modes.md). */
  readonly mode: 'local';
  readonly local?: {
    /**
     * Per-key boolean overrides — the seeded local map. A present key
     * resolves with reason `STATIC`; an absent key misses so the caller's own
     * default is used. May be empty or omitted entirely.
     */
    readonly controlPoints?: Record<string, boolean>;
    /**
     * Sink for the `[fireweave:local]` registerTarget trace line
     * (spec/modes.md "registerTarget in local mode"). Defaults to
     * `console.info`.
     */
    readonly log?: (message: string) => void;
  };
}

export type InitFireweaveOptions = InitFireweaveRemoteOptions | InitFireweaveLocalOptions;

async function initLocal(options: InitFireweaveLocalOptions): Promise<FireweaveClient> {
  const local = options.local ?? {};
  const adapter = new FireweaveLocalAdapter({
    devFlags: local.controlPoints ?? {},
    ...(local.log !== undefined ? { log: local.log } : {}),
  });
  const runtime = new FireweaveRuntime(adapter);
  await runtime.initialize();
  return new FireweaveClient(runtime);
}

async function initRemote(options: InitFireweaveRemoteOptions): Promise<FireweaveClient> {
  const { apiKey, apiUrl, allowedHosts, fetch } = options;

  const adapter = new FireweaveRemoteAdapter({
    apiKey,
    apiUrl,
    ...(allowedHosts !== undefined ? { allowedHosts } : {}),
    ...(fetch !== undefined ? { fetch } : {}),
  });
  const runtime = new FireweaveRuntime(adapter, {
    // The same host the adapter will actually call, gated through the
    // canonical allowlist (hosts.ts) before any network I/O happens.
    host: apiUrl,
    ...(allowedHosts !== undefined ? { allowedHosts } : {}),
  });
  await runtime.initialize();
  return new FireweaveClient(runtime);
}

/**
 * Build the adapter matching `options.mode` and bring a {@link FireweaveClient}
 * to READY.
 *
 * Throws {@link FireweaveError} (kind `Configuration`) for every row of the
 * initialisation-validation table (spec/modes.md):
 *  - `mode` absent or unrecognised
 *  - `mode: 'remote'` with `apiKey` or `apiUrl` missing/blank
 *  - `apiUrl` fails the host allowlist
 *  - `mode: 'local'` with credentials supplied
 *
 * The first, second and fourth rows are `validateInitOptions`'s job; the
 * third is validated downstream, when `runtime.initialize()` brings the
 * adapter up (`FireweaveRuntime`'s own config validation, `hosts.ts`).
 */
export async function initFireweave(options: InitFireweaveOptions): Promise<FireweaveClient> {
  const validated = validateInitOptions(options);
  if (!validated.ok) throw validated.error;
  const validOptions = validated.value;
  return validOptions.mode === 'local' ? initLocal(validOptions) : initRemote(validOptions);
}
