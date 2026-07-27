/**
 * Backend host allowlist (SSRF guard, release-blockers H-1).
 *
 * The allowlist is ON by default: when no explicit `allowedHosts` is
 * configured, only the canonical PostHog hosts plus loopback are permitted.
 * The canonical default list is identical across all four SDK languages
 * (orchestrator ruling, Phase 5). Custom/self-hosted endpoints require an
 * explicit `allowedHosts` entry; `['*']` opts out entirely.
 *
 * Scheme policy: https is required for non-loopback hosts; plain http is
 * permitted on loopback only (the repo's test-server stub).
 */
import { FireweaveError } from './errors.js';

/** Canonical default host allowlist (same across all SDK languages). */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = Object.freeze([
  'app.posthog.com',
  'us.posthog.com',
  'eu.posthog.com',
  'us.i.posthog.com',
  'eu.i.posthog.com',
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
