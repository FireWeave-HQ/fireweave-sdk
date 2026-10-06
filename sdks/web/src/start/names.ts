/**
 * Every name the web start profile and its build helpers use, in one place, so
 * the README, the initialise skill and the error messages cannot drift apart.
 *
 * Imported by browser code and by the Node build helpers (node/), so it holds
 * constants only.
 */

/** Build-time variables the Vite plugin and the define helper read. The browser reads none. */
export const BUILD_ENV = Object.freeze({
  key: 'FIREWEAVE_BROWSER_KEY',
  url: 'FIREWEAVE_URL',
  environment: 'FIREWEAVE_ENV',
});

/** Fallback environment name after FIREWEAVE_ENV, at build time. */
export const ENVIRONMENT_FALLBACK = 'APP_ENV';

/**
 * Names the scaffolded harness used for the browser key. They held a project
 * (server-family) key, which the start profile refuses, so they are detected
 * only to explain what to set instead.
 */
export const RETIRED_KEY_NAMES: readonly string[] = Object.freeze(['VITE_FW_PROJECT_API_KEY', 'PUBLIC_FW_PROJECT_API_KEY']);

/** Server secrets the Vite plugin looks for in output chunks. Never injected, never printed. */
export const SERVER_KEY_NAMES: readonly string[] = Object.freeze(['FIREWEAVE_KEY', 'FW_PROJECT_API_KEY']);

/** Environment names that mean "local development" when no key is set. Case-insensitive. */
export const DEV_ENVIRONMENTS: ReadonlySet<string> = new Set(['development', 'dev', 'local', 'test']);

/** fw-server host for each release channel of this package. */
export const CHANNEL_URLS = Object.freeze({
  production: 'https://app-server.fireweave.ai',
  staging: 'https://staging-app-server.fireweave.ai',
});

/** Hosts always allowed beside a custom endpoint, so local stacks keep working. */
export const LOOPBACK_HOSTS: readonly string[] = Object.freeze(['localhost', '127.0.0.1', '::1']);

/** The only key family a browser may hold. */
export const BROWSER_KEY_PREFIX = 'fw_public_';

/** localStorage keys. The device id key and its dev_ prefix match the scaffolded harness, so returning visitors keep their bucket. */
export const STORAGE_KEYS = Object.freeze({
  deviceId: 'fireweave.device-id',
  identity: 'fireweave.identity',
  deviceRegistered: 'fireweave.device-registered',
});

/** Where the control-points object lives by convention; named in warnings. */
export const CONTROL_POINTS_FILE = 'src/fireweave/control-points.ts';

/** The identifier the build helpers define and the browser reads behind a typeof guard. */
export const INJECTED_CONFIG_NAME = '__FIREWEAVE_WEB_CONFIG__';
