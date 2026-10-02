/**
 * Pure start-profile resolver: options + env + build stamp in, one resolved
 * config out. No I/O, no globals, no timers — every rule here is unit-tested
 * through `resolveStart` alone.
 *
 * Precedence for every value: explicit start() option, then FIREWEAVE_* env,
 * then the legacy FW_* name (one warning), then the default. Reads are lazy:
 * a source is read only if every earlier source was unset, so an explicit
 * option never touches the environment (which matters on Deno).
 */
import { FireweaveError, assertHostAllowed } from '../index.js';
import type { EnvReader } from './env.js';
import { quiet } from './env.js';
import { normalizeFlags, type FlagMap } from './flags.js';
import {
  CHANNEL_URLS,
  DEV_ENVIRONMENTS,
  ENV,
  ENVIRONMENT_FALLBACKS,
  LEGACY_ENV,
  LOOPBACK_HOSTS,
  RETIRED_ENVIRONMENT_NAME,
} from './names.js';

export type StartMode = 'remote' | 'local';
export type SdkChannel = 'staging' | 'production';

export interface ResolveInput {
  readonly mode?: unknown;
  readonly environment?: unknown;
  readonly url?: unknown;
  readonly key?: unknown;
  readonly flags?: unknown;
}

export interface BuildInfo {
  readonly version: string;
  readonly channel: SdkChannel;
}

export interface ResolvedStart {
  readonly mode: StartMode;
  /** Why this mode: the mode option, a present key, or the environment name. */
  readonly modeSource: 'option' | 'key' | 'environment';
  /** Remote only. */
  readonly url?: string;
  readonly urlSource?: string;
  readonly allowedHosts?: readonly string[];
  /** Remote only. Never logged or printed. */
  readonly key?: string;
  readonly keySource: string;
  /** Set when the environment name was consulted (no key, no mode option). */
  readonly environment?: string;
  readonly environmentSource?: string;
  readonly flags: FlagMap;
  readonly channel: SdkChannel;
  readonly sdkVersion: string;
  /** Lines to log once each: legacy names, ignored keys. */
  readonly warnings: readonly string[];
}

const configError = (message: string): FireweaveError => new FireweaveError('Configuration', { message });

const optionString = (value: unknown, name: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw configError(`[fireweave] start({ ${name} }) must be a string.`);
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

interface Sourced {
  readonly value: string;
  readonly source: string;
}

/** First non-empty of: the option, then each env name in order. */
function pick(
  option: string | undefined,
  optionName: string,
  names: readonly string[],
  legacy: readonly string[],
  read: EnvReader,
  warnings: string[],
  replacement: string,
): Sourced | undefined {
  if (option !== undefined) return { value: option, source: `start({ ${optionName} })` };
  for (const name of names) {
    const value = read(name);
    if (value !== undefined) return { value, source: name };
  }
  for (const name of legacy) {
    const value = read(name);
    if (value !== undefined) {
      warnings.push(
        `[fireweave] ${name} is a legacy name and will stop being read in 3.0.0. Rename it to ${replacement}; the value does not change.`,
      );
      return { value, source: name };
    }
  }
  return undefined;
}

/**
 * Key family check, before any request. Messages name the source, never the
 * value. The redactor masks analytics-vendor prefixes, so the message says
 * "analytics vendor key" instead of quoting one.
 */
function checkKeyFamily(key: string, source: string): void {
  if (key.startsWith('fw_public_')) {
    throw configError(
      `[fireweave] The key from ${source} is a browser key (fw_public_…). Server apps need a project key (project-api-key_…) from Project settings, API keys.`,
    );
  }
  if (/^ph[a-z]_/.test(key)) {
    throw configError(
      `[fireweave] The key from ${source} is an analytics vendor key, not a FireWeave project key. Use the project key (project-api-key_…).`,
    );
  }
  if (key.startsWith('fw_org_') || key.startsWith('cli_at_')) {
    throw configError(
      `[fireweave] The key from ${source} is an organisation or CLI token, not a project key. Use the project key (project-api-key_…).`,
    );
  }
}

function resolveUrl(input: ResolveInput, read: EnvReader, build: BuildInfo, warnings: string[]) {
  const picked = pick(
    optionString(input.url, 'url'),
    'url',
    [ENV.url],
    LEGACY_ENV.url,
    read,
    warnings,
    ENV.url,
  );
  if (picked === undefined) {
    // The channel host is in DEFAULT_ALLOWED_HOSTS, so no custom allowlist.
    return { url: CHANNEL_URLS[build.channel], urlSource: `SDK channel (${build.channel})` };
  }
  const url = picked.value.replace(/\/+$/, '');
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw configError(`[fireweave] The endpoint from ${picked.source} is not a valid URL.`);
  }
  const allowedHosts = [hostname.replace(/^\[|\]$/g, ''), ...LOOPBACK_HOSTS];
  try {
    assertHostAllowed(url, allowedHosts);
  } catch {
    throw configError(
      `[fireweave] The endpoint from ${picked.source} must use https (http is allowed only for localhost).`,
    );
  }
  return { url, urlSource: picked.source, allowedHosts };
}

function resolveKey(input: ResolveInput, read: EnvReader, warnings: string[]): Sourced | undefined {
  const picked = pick(optionString(input.key, 'key'), 'key', [ENV.key], LEGACY_ENV.key, read, warnings, ENV.key);
  if (picked !== undefined) checkKeyFamily(picked.value, picked.source);
  return picked;
}

function resolveEnvironment(input: ResolveInput, read: EnvReader): Sourced | undefined {
  return pick(
    optionString(input.environment, 'environment'),
    'environment',
    [ENV.environment, ...ENVIRONMENT_FALLBACKS],
    [],
    read,
    [],
    ENV.environment,
  );
}

function noKeyError(env: Sourced | undefined, read: EnvReader): FireweaveError {
  const where = env === undefined
    ? 'no environment name is set (checked the environment option, FIREWEAVE_ENV, APP_ENV and NODE_ENV)'
    : `the environment is '${env.value}' (from ${env.source}), which is not a development name`;
  const retired = env === undefined && quiet(read)(RETIRED_ENVIRONMENT_NAME) !== undefined
    ? ` FW_ENV is no longer read; rename it to FIREWEAVE_ENV.`
    : '';
  return configError(
    `[fireweave] ${ENV.key} is not set and ${where}. Set ${ENV.key} to the project's server key, or for local development set FIREWEAVE_ENV=development or call start({ mode: 'local' }).${retired}`,
  );
}

/**
 * Resolve start() options against the environment.
 * Throws FireweaveError('Configuration') naming the variable at fault.
 */
export function resolveStart(input: ResolveInput, read: EnvReader, build: BuildInfo): ResolvedStart {
  const warnings: string[] = [];
  const flags = normalizeFlags(input.flags);
  const base = { flags, channel: build.channel, sdkVersion: build.version };

  if (input.mode !== undefined && input.mode !== 'remote' && input.mode !== 'local') {
    throw configError(`[fireweave] start({ mode }) must be 'remote' or 'local'.`);
  }

  if (input.mode === 'local') {
    // The key is ignored. Look only to warn, and never fail on a refused read.
    const ignored = resolveKeyQuietly(input, read);
    if (ignored !== undefined) {
      warnings.push(`[fireweave] start({ mode: 'local' }) ignores the key from ${ignored}; nothing is sent to fw-server.`);
    }
    return { ...base, mode: 'local', modeSource: 'option', keySource: 'none', warnings };
  }

  const key = resolveKey(input, read, warnings);

  if (input.mode === 'remote') {
    if (key === undefined) {
      throw configError(
        `[fireweave] start({ mode: 'remote' }) needs a key. Set ${ENV.key} or pass start({ key }).`,
      );
    }
    return { ...base, mode: 'remote', modeSource: 'option', ...resolveUrl(input, read, build, warnings), key: key.value, keySource: key.source, warnings };
  }

  if (key !== undefined) {
    return { ...base, mode: 'remote', modeSource: 'key', ...resolveUrl(input, read, build, warnings), key: key.value, keySource: key.source, warnings };
  }

  const env = resolveEnvironment(input, read);
  if (env !== undefined && DEV_ENVIRONMENTS.has(env.value.toLowerCase())) {
    return {
      ...base,
      mode: 'local',
      modeSource: 'environment',
      keySource: 'none',
      environment: env.value,
      environmentSource: env.source,
      warnings,
    };
  }
  throw noKeyError(env, read);
}

function resolveKeyQuietly(input: ResolveInput, read: EnvReader): string | undefined {
  if (typeof input.key === 'string' && input.key.trim() !== '') return 'start({ key })';
  const safe = quiet(read);
  for (const name of [ENV.key, ...LEGACY_ENV.key]) {
    if (safe(name) !== undefined) return name;
  }
  return undefined;
}
