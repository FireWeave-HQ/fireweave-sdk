/**
 * The web start-profile policy: one pure resolver shared by the browser
 * start() and the Node build helpers (node/vite.ts, node/define.ts), so a
 * build and the page it produces can never disagree about mode, key or URL.
 *
 * Pure on purpose: no DOM, no env, no core import. Callers hand in values
 * with their source names; the result is a config, or a failure carrying a
 * fixed reason code and a message that names sources and variables, never a
 * value.
 */
import { BROWSER_KEY_PREFIX, CHANNEL_URLS, DEV_ENVIRONMENTS, LOOPBACK_HOSTS } from './names.js';

export type StartMode = 'remote' | 'local';
export type SdkChannel = 'staging' | 'production';

/** A value and where it came from ('start({ key })', 'FIREWEAVE_BROWSER_KEY', ...). */
export interface Sourced {
  readonly value: string;
  readonly source: string;
}

export type PolicyReason = 'invalid-mode' | 'missing-key' | 'server-key' | 'wrong-key-family' | 'insecure-url';

export interface PolicyInput {
  readonly mode?: unknown;
  readonly key?: Sourced | undefined;
  readonly url?: Sourced | undefined;
  readonly environment?: Sourced | undefined;
  readonly channel: SdkChannel;
  /** The variable or option a fix should name, e.g. FIREWEAVE_BROWSER_KEY. */
  readonly keyVariable: string;
  /** Where an environment name was looked for, for the missing-key message. */
  readonly environmentChecked: string;
}

export interface PolicyConfig {
  readonly mode: StartMode;
  /** Why this mode: the mode option, a present key, or the environment name. */
  readonly modeSource: 'option' | 'key' | 'environment';
  /** Remote only. A value starting with '/' is a same-origin proxy path. */
  readonly url?: string;
  readonly urlSource?: string;
  /** Remote only, and absent for the channel default (the core's own list covers it). */
  readonly allowedHosts?: readonly string[];
  /** Remote only. Never logged. */
  readonly key?: string;
  readonly keySource: string;
  readonly environment?: string;
  readonly environmentSource?: string;
}

export type PolicyResult =
  | { readonly ok: true; readonly config: PolicyConfig; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly reason: PolicyReason; readonly variable: string; readonly message: string };

/** A trimmed, non-empty string with its source, or undefined. Non-strings count as unset. */
export function sourced(value: unknown, source: string): Sourced | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : { value: trimmed, source };
}

/** The first candidate that is set. */
export function firstOf(...candidates: ReadonlyArray<Sourced | undefined>): Sourced | undefined {
  return candidates.find((c) => c !== undefined);
}

const fail = (reason: PolicyReason, variable: string, message: string): PolicyResult => ({
  ok: false,
  reason,
  variable,
  message: `[fireweave] ${message}`,
});

/** Key family check. Messages name the source, never the value. */
function checkKey(key: Sourced): PolicyResult | undefined {
  const v = key.value;
  if (v.startsWith(BROWSER_KEY_PREFIX)) return undefined;
  if (v.startsWith('project-api-key_')) {
    return fail(
      'server-key',
      key.source,
      `The key from ${key.source} is a server key (project-api-key_…), which must never ship to a browser. Use a browser key (fw_public_…) from Project settings, API keys. If a bundle built with this key was deployed, revoke the key.`,
    );
  }
  if (/^ph[a-z]_/.test(v)) {
    return fail('wrong-key-family', key.source, `The key from ${key.source} is an analytics vendor key, not a FireWeave browser key (fw_public_…).`);
  }
  if (v.startsWith('fw_org_') || v.startsWith('cli_at_')) {
    return fail('wrong-key-family', key.source, `The key from ${key.source} is an organisation or CLI token, not a FireWeave browser key (fw_public_…).`);
  }
  return fail('wrong-key-family', key.source, `The key from ${key.source} is not a FireWeave browser key (fw_public_…).`);
}

const isLoopback = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';

function resolveUrl(
  url: Sourced | undefined,
  channel: SdkChannel,
): { url: string; urlSource: string; allowedHosts?: readonly string[] } | PolicyResult {
  if (url === undefined) return { url: CHANNEL_URLS[channel], urlSource: `SDK channel (${channel})` };
  const value = url.value.replace(/\/+$/, '');
  if (value.startsWith('//')) {
    return fail('insecure-url', url.source, `The endpoint from ${url.source} is protocol-relative. Use an https URL or a same-origin path such as '/fw'.`);
  }
  // A same-origin proxy path: the browser resolves it against location.origin.
  if (value.startsWith('/')) return { url: value, urlSource: url.source };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail('insecure-url', url.source, `The endpoint from ${url.source} is not a valid URL.`);
  }
  const httpsOk = parsed.protocol === 'https:';
  const loopbackHttp = parsed.protocol === 'http:' && isLoopback(parsed.hostname);
  if (!httpsOk && !loopbackHttp) {
    return fail('insecure-url', url.source, `The endpoint from ${url.source} must use https (http is allowed only for localhost).`);
  }
  return { url: value, urlSource: url.source, allowedHosts: [parsed.hostname.replace(/^\[|\]$/g, ''), ...LOOPBACK_HOSTS] };
}

function remote(
  input: PolicyInput,
  key: Sourced,
  modeSource: 'option' | 'key',
  warnings: string[],
): PolicyResult {
  const keyProblem = checkKey(key);
  if (keyProblem !== undefined) return keyProblem;
  const url = resolveUrl(input.url, input.channel);
  if ('ok' in url) return url;
  return { ok: true, config: { mode: 'remote', modeSource, ...url, key: key.value, keySource: key.source }, warnings };
}

/**
 * Resolve mode, key and endpoint.
 *
 * An explicit mode wins. Otherwise a key means remote; no key and a
 * development environment name means local; anything else fails closed, so a
 * missing key never turns into silent local evaluation for real visitors.
 */
export function resolvePolicy(input: PolicyInput): PolicyResult {
  const warnings: string[] = [];
  const { mode, key, environment } = input;

  if (mode !== undefined && mode !== 'remote' && mode !== 'local') {
    return fail('invalid-mode', 'mode', `start({ mode }) must be 'remote' or 'local'.`);
  }

  if (mode === 'local') {
    if (key !== undefined) {
      warnings.push(`[fireweave] mode 'local' ignores the key from ${key.source}; nothing is sent to fw-server.`);
    }
    return { ok: true, config: { mode: 'local', modeSource: 'option', keySource: 'none' }, warnings };
  }

  if (mode === 'remote') {
    if (key === undefined) {
      return fail('missing-key', input.keyVariable, `mode 'remote' needs a browser key. Set ${input.keyVariable} to a browser key (fw_public_…).`);
    }
    return remote(input, key, 'option', warnings);
  }

  if (key !== undefined) return remote(input, key, 'key', warnings);

  if (environment !== undefined && DEV_ENVIRONMENTS.has(environment.value.toLowerCase())) {
    return {
      ok: true,
      config: {
        mode: 'local',
        modeSource: 'environment',
        keySource: 'none',
        environment: environment.value,
        environmentSource: environment.source,
      },
      warnings,
    };
  }

  const where =
    environment === undefined
      ? `no environment name is set (checked ${input.environmentChecked})`
      : `the environment is '${environment.value}' (from ${environment.source}), which is not a development name`;
  return fail(
    'missing-key',
    input.keyVariable,
    `${input.keyVariable} is not set and ${where}. Set ${input.keyVariable} to a browser key (fw_public_…), or for local work set FIREWEAVE_ENV=development or pass start({ mode: 'local' }).`,
  );
}

/**
 * What the build helpers inject as __FIREWEAVE_WEB_CONFIG__: raw values and
 * their source names, re-resolved in the browser so explicit start() options
 * still win. Never carries a server key or the flags object.
 */
export interface InjectedConfig {
  readonly v: 1;
  readonly key?: string;
  readonly keySource?: string;
  readonly url?: string;
  readonly urlSource?: string;
  readonly environment?: string;
  readonly environmentSource?: string;
}
