/**
 * Backend host allowlist — the same SSRF guard the server SDK applies, kept
 * for a different reason.
 *
 * A browser cannot be tricked into reaching a cloud metadata endpoint the way a
 * server can; the browser's own origin model already prevents that. What this
 * guard buys here is narrower and still worth having: a mistyped or tampered
 * `apiUrl` cannot quietly send a project key, a targeting key, and a user's
 * evaluation attributes to an unintended host. The allowlist is ON by default,
 * so reaching a self-hosted fw-server is a deliberate, explicit act.
 *
 * Scheme policy matches the server SDK: https everywhere except loopback,
 * where plain http is allowed for local development against a dev server.
 */
import { FireweaveError } from './errors.js';

export const DEFAULT_ALLOWED_HOSTS: readonly string[] = Object.freeze([
  'app-server.fireweave.ai',
  'staging-app-server.fireweave.ai',
  'localhost',
  '127.0.0.1',
  '::1',
]);

export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

/**
 * Validate a backend URL against the allowlist.
 * Throws `FireweaveError('Configuration')` — fixed message, no host echoed,
 * because this message can land in a shared browser console.
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
    throw new FireweaveError('Configuration');
  }
  const list =
    allowedHosts !== undefined && allowedHosts.length > 0 ? allowedHosts : DEFAULT_ALLOWED_HOSTS;
  if (list.includes('*')) return; // explicit opt-out
  const allowed = list.some(
    (h) =>
      url.hostname === h ||
      (h === 'localhost' && loopback) ||
      (h === '::1' && url.hostname === '[::1]')
  );
  if (!allowed) {
    throw new FireweaveError('Configuration');
  }
}

/**
 * Key shapes this SDK refuses to accept.
 *
 * The whole security argument for a browser package (ADR-0009) is that it never
 * wants a secret. Enforcing that at the door — rather than trusting that no
 * code path asks for one — turns the claim into something a caller cannot
 * accidentally violate by pasting the wrong value into their bundle config.
 */
const FORBIDDEN_KEY_PREFIXES: readonly string[] = Object.freeze(['phs_', 'phx_', 'phc_']);

/** Throw if `apiKey` looks like a vendor or secret key rather than a Fireweave project key. */
export function assertNotSecretKey(apiKey: string): void {
  const key = apiKey.trim();
  if (key.length === 0) throw new FireweaveError('Configuration');
  for (const prefix of FORBIDDEN_KEY_PREFIXES) {
    if (key.startsWith(prefix)) {
      throw new FireweaveError('Configuration');
    }
  }
}
