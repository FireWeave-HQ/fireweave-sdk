/**
 * Build-time resolution shared by the Vite plugin and the define helper.
 * Runs in Node at config time, never in a browser. It reuses the browser's
 * own policy (src/start/policy.ts), so a build fails for exactly the reasons
 * the page would.
 */
import { SDK_CHANNEL } from '../src/start/build-info.js';
import { BUILD_ENV, RETIRED_KEY_NAMES } from '../src/start/names.js';
import { firstOf, resolvePolicy, sourced, type InjectedConfig, type PolicyConfig, type Sourced } from '../src/start/policy.js';

/** A variable read at build time: its value and a source label for logs (never the value). */
export type EnvLookup = (name: string) => Sourced | undefined;

export interface BuildOptions {
  /** Browser key. Prefer FIREWEAVE_BROWSER_KEY in the build environment. */
  readonly key?: string;
  /** fw-server URL or a same-origin proxy path ('/fw'). Default: FIREWEAVE_URL, else the SDK channel host. */
  readonly url?: string;
  /** Environment name for the mode rule. Default: FIREWEAVE_ENV, else APP_ENV. */
  readonly environment?: string;
}

export interface BuildResolution {
  readonly config: PolicyConfig;
  readonly injected: InjectedConfig;
  readonly warnings: readonly string[];
}

export function resolveBuild(
  options: BuildOptions,
  lookup: EnvLookup,
  keyVariable: string,
  environmentNames: readonly string[],
  extraEnvironment?: Sourced,
): BuildResolution {
  const key = firstOf(sourced(options.key, 'fireweave({ key })'), lookup(keyVariable));
  const url = firstOf(sourced(options.url, 'fireweave({ url })'), lookup(BUILD_ENV.url));
  const environment = firstOf(
    sourced(options.environment, 'fireweave({ environment })'),
    ...environmentNames.map((name) => lookup(name)),
    extraEnvironment,
  );
  const warnings: string[] = [];
  if (key === undefined) {
    for (const name of RETIRED_KEY_NAMES) {
      if (lookup(name) !== undefined) {
        warnings.push(`[fireweave] ${name} is not read by the start profile: it held a server-family key. Create a browser key (fw_public_…) and set ${keyVariable}.`);
      }
    }
  }
  const checked = [`fireweave({ environment })`, ...environmentNames, ...(extraEnvironment !== undefined ? [extraEnvironment.source] : [])].join(', ');
  const policy = resolvePolicy({ key, url, environment, channel: SDK_CHANNEL, keyVariable, environmentChecked: checked });
  if (!policy.ok) throw new Error(policy.message);
  const config = policy.config;
  const injected: InjectedConfig = {
    v: 1,
    ...(config.mode === 'remote' && key !== undefined ? { key: key.value, keySource: key.source } : {}),
    ...(url !== undefined ? { url: url.value, urlSource: url.source } : {}),
    ...(environment !== undefined ? { environment: environment.value, environmentSource: environment.source } : {}),
  };
  return { config, injected, warnings: [...warnings, ...policy.warnings] };
}

/** One summary line for build output. Names sources, never values. */
export function summaryLine(config: PolicyConfig): string {
  if (config.mode === 'local') {
    const why = config.modeSource === 'environment' ? `environment '${config.environment ?? ''}' from ${config.environmentSource ?? ''}` : 'mode option';
    return `[fireweave] local mode (${why}): values come from your control-points object; nothing is sent to fw-server.`;
  }
  const host = config.url !== undefined && !config.url.startsWith('/') ? new URL(config.url).host : config.url;
  return `[fireweave] remote mode: browser key from ${config.keySource}, fw-server ${host} (${config.urlSource ?? ''}).`;
}
