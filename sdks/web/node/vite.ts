/**
 * @fireweaveai/web-sdk/vite — the fireweave() Vite plugin.
 *
 *   // vite.config.ts
 *   import { fireweave } from '@fireweaveai/web-sdk/vite';
 *   export default defineConfig({ plugins: [fireweave()] });
 *
 * At config time (Node) it reads FIREWEAVE_BROWSER_KEY, FIREWEAVE_URL and the
 * environment name from the process environment and Vite's env files, applies
 * the start profile's policy, and either fails the dev server or build with a
 * message naming the variable, or injects the result as
 * __FIREWEAVE_WEB_CONFIG__ for start() to pick up. After a client build it
 * fails if a server key reached any output file.
 *
 * Environment name: FIREWEAVE_ENV, then APP_ENV; the dev server and Vitest
 * also fall back to Vite's mode. A build never infers local mode from
 * `--mode development`, so a production build without a key fails.
 *
 * Node build tooling: nothing here ships to the browser. vite is an optional
 * peer and is loaded lazily, so this file has no static import of it.
 */
import { resolve as resolvePath } from 'node:path';
import { BUILD_ENV, ENVIRONMENT_FALLBACK, INJECTED_CONFIG_NAME, SERVER_KEY_NAMES } from '../src/start/names.js';
import { sourced, type Sourced } from '../src/start/policy.js';
import { resolveBuild, summaryLine, type BuildOptions, type EnvLookup } from './shared.js';

export type FireweavePluginOptions = BuildOptions;

/** The subset of Vite's types the plugin touches, so the package needs no vite types to build. */
interface UserConfigLike {
  readonly root?: string;
  readonly envDir?: string | false;
  readonly build?: { readonly lib?: unknown };
}
interface ConfigEnvLike {
  readonly command: 'serve' | 'build';
  readonly mode: string;
  readonly isPreview?: boolean;
}
interface ResolvedConfigLike {
  readonly envPrefix?: string | readonly string[];
  readonly build?: { readonly ssr?: unknown };
}
type OutputFileLike = { readonly type: 'chunk'; readonly code: string } | { readonly type: 'asset'; readonly source: string | Uint8Array };
interface PluginContextLike {
  readonly environment?: { readonly config?: { readonly consumer?: string } };
}

export type LoadEnv = (mode: string, envDir: string, prefixes: string[]) => Record<string, string> | Promise<Record<string, string>>;

export interface FireweaveVitePlugin {
  readonly name: 'fireweave';
  readonly enforce: 'pre';
  config(userConfig: UserConfigLike, env: ConfigEnvLike): Promise<Record<string, unknown> | undefined>;
  configResolved(config: ResolvedConfigLike): void;
  generateBundle(this: PluginContextLike, options: unknown, bundle: Readonly<Record<string, OutputFileLike>>): void;
}

/** Test seam: the env-file loader and the process environment. */
export interface PluginDeps {
  readonly loadEnv?: LoadEnv;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly log?: (line: string) => void;
}

const ENV_PREFIXES = ['FIREWEAVE_', ENVIRONMENT_FALLBACK, 'VITE_FW_', 'PUBLIC_FW_'];
const SERVER_KEY_PATTERN = /project-api-key_[A-Za-z0-9_-]{8,}/;

async function viteLoadEnv(): Promise<LoadEnv> {
  const specifier = 'vite';
  const vite = (await import(specifier)) as { loadEnv: LoadEnv };
  return vite.loadEnv;
}

/** Mirror Vite's env-file location: envDir resolved against the resolved root; false disables files. */
function envDirOf(userConfig: UserConfigLike): string | false {
  if (userConfig.envDir === false) return false;
  const root = resolvePath(userConfig.root ?? process.cwd());
  return userConfig.envDir !== undefined ? resolvePath(root, userConfig.envDir) : root;
}

export function createFireweavePlugin(options: FireweavePluginOptions = {}, deps: PluginDeps = {}): FireweaveVitePlugin {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.info(line));
  let skip = false;
  let clientSsr = false;

  return {
    name: 'fireweave',
    enforce: 'pre',

    async config(userConfig, configEnv) {
      if (configEnv.isPreview === true) {
        skip = true;
        return undefined;
      }
      if (userConfig.build?.lib !== undefined && userConfig.build.lib !== false) {
        skip = true;
        log('[fireweave] build.lib: no config injected. A library must not bake in an app key; the app that bundles it runs fireweave().');
        return undefined;
      }

      const envDir = envDirOf(userConfig);
      const loadEnv = deps.loadEnv ?? (envDir === false ? undefined : await viteLoadEnv());
      const files = envDir === false || loadEnv === undefined ? {} : await loadEnv(configEnv.mode, envDir, ENV_PREFIXES);
      const lookup: EnvLookup = (name) => sourced(env[name], name) ?? sourced(files[name], `${name} (.env files)`);

      const viteMode: Sourced | undefined =
        configEnv.command === 'serve' ? sourced(configEnv.mode, `Vite mode '${configEnv.mode}'`) : undefined;
      const resolved = resolveBuild(options, lookup, BUILD_ENV.key, [BUILD_ENV.environment, ENVIRONMENT_FALLBACK], viteMode);
      for (const w of resolved.warnings) log(w);
      log(summaryLine(resolved.config));

      return {
        define: { [INJECTED_CONFIG_NAME]: JSON.stringify(resolved.injected) },
        // Keep the SDK out of the dep pre-bundle so the injected config is never cached stale.
        optimizeDeps: { exclude: ['@fireweaveai/web-sdk'] },
      };
    },

    configResolved(config) {
      if (skip) return;
      const prefixes = config.envPrefix === undefined ? ['VITE_'] : typeof config.envPrefix === 'string' ? [config.envPrefix] : [...config.envPrefix];
      const exposed = SERVER_KEY_NAMES.filter((name) => prefixes.some((p) => p !== '' && name.startsWith(p)));
      if (exposed.length > 0) {
        throw new Error(
          `[fireweave] envPrefix would expose ${exposed.join(' and ')} to the browser bundle. Remove that prefix; the browser key is injected by fireweave() as ${BUILD_ENV.key}.`,
        );
      }
      clientSsr = config.build?.ssr !== undefined && config.build.ssr !== false;
    },

    generateBundle(_options, bundle) {
      if (skip) return;
      const serverEnvironment = this.environment?.config?.consumer === 'server' || (this.environment === undefined && clientSsr);
      if (serverEnvironment) return;
      const secrets = SERVER_KEY_NAMES.map((name) => env[name]?.trim()).filter((v): v is string => v !== undefined && v.length >= 8);
      for (const [fileName, file] of Object.entries(bundle)) {
        const text = file.type === 'chunk' ? file.code : typeof file.source === 'string' ? file.source : '';
        if (SERVER_KEY_PATTERN.test(text) || secrets.some((secret) => text.includes(secret))) {
          throw new Error(
            `[fireweave] ${fileName} contains a server key. Server keys must never ship to a browser: remove it from client code, and revoke it if this build was deployed.`,
          );
        }
      }
    },
  };
}

/** The fireweave() Vite plugin. Add it to `plugins` in vite.config.ts (or a framework's `vite.plugins`). */
export function fireweave(options: FireweavePluginOptions = {}): FireweaveVitePlugin {
  return createFireweavePlugin(options);
}

