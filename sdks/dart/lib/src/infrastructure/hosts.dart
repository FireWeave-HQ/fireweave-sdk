/// Backend host allowlist (SSRF guard).
///
/// The allowlist is ON by default: when no explicit `allowedHosts` is
/// configured, only the canonical Fireweave hosts plus loopback are
/// permitted, so a typo'd or tampered host cannot be aimed at cloud
/// metadata endpoints — or, on a device, cannot quietly send a project key,
/// a targeting key, and a user's evaluation attributes to an unintended
/// host. Custom/self-hosted deployments require an explicit `allowedHosts`
/// entry; `['*']` opts out entirely.
///
/// Scheme policy: https is required for non-loopback hosts; plain http is
/// permitted on loopback only.
///
/// URL parsing uses `dart:core`'s [Uri] — already part of the zero-
/// dependency budget, the same way swift reached for Foundation's
/// `URLComponents`.
library;

import '../domain/errors.dart';

/// Canonical default host allowlist: Fireweave's own fw-server hostnames
/// plus loopback. An unconfigured allowlist denies everything it does not
/// name.
const List<String> defaultAllowedHosts = <String>[
  'app-server.fireweave.ai',
  'staging-app-server.fireweave.ai',
  'localhost',
  '127.0.0.1',
  '::1',
];

const Set<String> _loopbackHosts = <String>{'localhost', '127.0.0.1', '::1'};

/// True for loopback hostnames (http and test stubs are permitted here).
bool isLoopbackHostname(String hostname) => _loopbackHosts.contains(hostname);

/// Extracts `(scheme, host)` from a URL string. Returns `null` when the
/// input has no parseable scheme/host — callers treat that as an invalid
/// configuration.
({String scheme, String host})? parseSchemeAndHost(String urlString) {
  final uri = Uri.tryParse(urlString);
  if (uri == null || uri.scheme.isEmpty || uri.host.isEmpty) {
    return null;
  }
  return (scheme: uri.scheme.toLowerCase(), host: uri.host.toLowerCase());
}

/// Validates a backend host URL against the allowlist.
///
/// Throws a [FireweaveError] of kind `Configuration` — fixed message, no
/// host echo, because this message can land in a shared device log.
/// [initFatal] is `true` at both call sites (`initFireweave`'s sanctioned
/// entry point, `FireweaveRemoteAdapter.initialize`'s own safety-net check
/// for direct adapter construction that bypasses `initFireweave`) — a
/// host-allowlist rejection maps to `PROVIDER_FATAL`, matching every other
/// SDK (`contracts/security/sec-endpoint-ssrf-allowlist.json`).
void assertHostAllowed(
  String url, {
  List<String>? allowedHosts,
  required bool initFatal,
}) {
  FireweaveError reject() => FireweaveError.configuration(
    'invalid configuration',
    initFatal: initFatal,
  );

  final parsed = parseSchemeAndHost(url);
  if (parsed == null) {
    throw reject();
  }
  final (:scheme, :host) = parsed;
  if (scheme != 'http' && scheme != 'https') {
    throw reject();
  }

  final loopback = isLoopbackHostname(host);
  if (scheme == 'http' && !loopback) {
    // https required for anything that leaves the machine.
    throw reject();
  }

  final allow = (allowedHosts != null && allowedHosts.isNotEmpty)
      ? allowedHosts.map((h) => h.toLowerCase()).toList()
      : defaultAllowedHosts;
  if (allow.contains('*')) {
    return; // explicit opt-out
  }
  if (!allow.contains(host)) {
    throw reject();
  }
}

/// Adapter-level default when the caller supplies no `allowedHosts`: the
/// URL's own hostname plus loopback (`FireweaveRemoteAdapter`'s fallback for
/// direct construction that bypasses `initFireweave`'s canonical default).
List<String>? defaultAllowedHostsFor(String apiUrl) {
  final parsed = parseSchemeAndHost(apiUrl);
  if (parsed == null) {
    return null;
  }
  return <String>[parsed.host, 'localhost', '127.0.0.1', '::1'];
}
