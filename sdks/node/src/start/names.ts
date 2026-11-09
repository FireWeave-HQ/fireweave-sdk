/**
 * Every name the start profile reads, in one place, so the README, the
 * initialise skill and the error messages cannot drift apart.
 */

/** Env vars the start profile reads. Explicit start() options always win. */
export const ENV = Object.freeze({
  key: 'FIREWEAVE_KEY',
  url: 'FIREWEAVE_URL',
  environment: 'FIREWEAVE_ENV',
  instanceId: 'FIREWEAVE_INSTANCE_ID',
});

/** Fallback env-name sources for mode inference, after the environment option and FIREWEAVE_ENV. */
export const ENVIRONMENT_FALLBACKS = Object.freeze(['APP_ENV', 'NODE_ENV'] as const);

/** Environment names that mean "local development" when no key is set. Case-insensitive. */
export const DEV_ENVIRONMENTS: ReadonlySet<string> = new Set(['development', 'dev', 'local', 'test']);

/** fw-server host for each release channel of this package. */
export const CHANNEL_URLS = Object.freeze({
  production: 'https://app-server.fireweave.ai',
  staging: 'https://staging-app-server.fireweave.ai',
});

/** Hosts always allowed beside a custom endpoint, so local stacks keep working. */
export const LOOPBACK_HOSTS: readonly string[] = Object.freeze(['localhost', '127.0.0.1', '::1']);
