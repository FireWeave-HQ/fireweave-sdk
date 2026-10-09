/**
 * @fireweaveai/web-sdk/define — the start profile's build check for bundlers
 * other than Vite (Next.js, webpack, esbuild, Rollup). No vite import.
 *
 *   // next.config.mjs (or any build config)
 *   import { fireweaveDefine } from '@fireweaveai/web-sdk/define';
 *   const define = fireweaveDefine(); // throws if the build would ship without a usable key
 *   // webpack: new webpack.DefinePlugin(define) · esbuild: { define } · Rollup: replace({ values: define })
 *
 * Reads process.env only: FIREWEAVE_BROWSER_KEY (or `keyVariable`),
 * FIREWEAVE_URL, and the environment name FIREWEAVE_ENV, then APP_ENV, then
 * NODE_ENV. Same policy and messages as the Vite plugin.
 */
import { BUILD_ENV, ENVIRONMENT_FALLBACK, INJECTED_CONFIG_NAME } from '../src/start/names.js';
import type { PolicyConfig } from '../src/start/policy.js';
import { sourced } from '../src/start/policy.js';
import { resolveBuild, summaryLine, type BuildOptions } from './shared.js';

export interface FireweaveDefineOptions extends BuildOptions {
  /** The variable holding the browser key. Default FIREWEAVE_BROWSER_KEY. */
  readonly keyVariable?: string;
  /** Read these values instead of process.env (tests). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Where the summary line goes. Default console.info. */
  readonly log?: (line: string) => void;
}

function resolveFromEnv(options: FireweaveDefineOptions) {
  const env = options.env ?? process.env;
  const lookup = (name: string) => sourced(env[name], name);
  const resolved = resolveBuild(options, lookup, options.keyVariable ?? BUILD_ENV.key, [BUILD_ENV.environment, ENVIRONMENT_FALLBACK, 'NODE_ENV']);
  const log = options.log ?? ((line: string) => console.info(line));
  for (const w of resolved.warnings) log(w);
  log(summaryLine(resolved.config));
  return resolved;
}

/** Fail the build (throw) when the start profile would not start; returns the resolved config. */
export function assertFireweaveBuild(options: FireweaveDefineOptions = {}): PolicyConfig {
  return resolveFromEnv(options).config;
}

/** assertFireweaveBuild, plus the define map that hands the result to start(). */
export function fireweaveDefine(options: FireweaveDefineOptions = {}): Record<string, string> {
  return { [INJECTED_CONFIG_NAME]: JSON.stringify(resolveFromEnv(options).injected) };
}
