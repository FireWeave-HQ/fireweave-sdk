/**
 * Backend host allowlist (SSRF guard, release-blockers H-1).
 *
 * The allowlist is ON by default: when no explicit `allowedHosts` is
 * configured, only the canonical Fireweave hosts plus loopback are permitted,
 * so a typo'd or tampered `host` cannot be aimed at cloud metadata endpoints.
 * Custom / self-hosted deployments require an explicit `allowedHosts` entry;
 * `['*']` opts out entirely.
 *
 * Scheme policy: https is required for non-loopback hosts; plain http is
 * permitted on loopback only (the repo's test-server stub).
 */
import { FireweaveError } from './errors.js';

/**
 * Canonical default host allowlist.
 *
 * v3 replaced the third-party analytics hostnames this list used to carry
 * (ADR-0006) with Fireweave's own fw-server hostnames. The security property is
 * unchanged — an unconfigured allowlist still denies everything it does not name
 * — but the *contents* changed: code doing
 * `allowedHosts: [...DEFAULT_ALLOWED_HOSTS, …]` no longer reaches the former
 * vendor endpoints, which is the intent.
 */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = Object.freeze([
  'app-server.fireweave.ai',
  'staging-app-server.fireweave.ai',
  'localhost',
  '127.0.0.1',
  '::1',
]);

/** True for loopback hostnames (http and test stubs are permitted here). */
export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

/**
 * Validate a backend host URL against the allowlist.
 * Throws FireweaveError('Configuration') — fixed message, no host echo.
 */
export function assertHostAllowed(host: string, allowedHosts?: readonly string[]): void {
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    throw new FireweaveError('Configuration');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FireweaveError('Configuration');
  }
  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol === 'http:' && !loopback) {
    // https required for anything that leaves the machine.
    throw new FireweaveError('Configuration');
  }
  const list =
    allowedHosts !== undefined && allowedHosts.length > 0 ? allowedHosts : DEFAULT_ALLOWED_HOSTS;
  if (list.includes('*')) return; // explicit opt-out
  const allowed = list.some(
    (h) =>
      url.hostname === h ||
      (h === 'localhost' && loopback) ||
      (h === '::1' && url.hostname === '[::1]'),
  );
  if (!allowed) {
    throw new FireweaveError('Configuration');
  }
}
