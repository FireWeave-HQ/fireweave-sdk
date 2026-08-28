import Foundation

/// Backend host allowlist (SSRF guard).
///
/// The allowlist is ON by default: when no explicit `allowedHosts` is
/// configured, only the canonical Fireweave hosts plus loopback are
/// permitted, so a typo'd or tampered host cannot be aimed at cloud metadata
/// endpoints. Custom/self-hosted deployments require an explicit
/// `allowedHosts` entry; `["*"]` opts out entirely.
///
/// Scheme policy: https is required for non-loopback hosts; plain http is
/// permitted on loopback only.
///
/// URL parsing uses Foundation's `URLComponents` — unlike rust (whose
/// dependency budget is a small, fixed crate count, so it hand-rolled a
/// scheme/host parser rather than add the `url` crate), swift's zero-
/// dependency ruling is "Foundation only", and `URLComponents` already IS
/// Foundation — reaching for a correct, already-available parser here is the
/// same spirit as rust's own choice (use what the budget already includes),
/// applied to a different budget shape.

/// Canonical default host allowlist: Fireweave's own fw-server hostnames
/// plus loopback. An unconfigured allowlist denies everything it does not
/// name.
public let defaultAllowedHosts: [String] = [
  "app-server.fireweave.ai",
  "staging-app-server.fireweave.ai",
  "localhost",
  "127.0.0.1",
  "::1",
]

private let loopbackHosts: Set<String> = ["localhost", "127.0.0.1", "::1"]

/// True for loopback hostnames (http and test stubs are permitted here).
public func isLoopbackHostname(_ hostname: String) -> Bool {
  loopbackHosts.contains(hostname)
}

/// Extracts `(scheme, hostname)` from a URL string. Returns `nil` when the
/// input has no parseable scheme/host — callers treat that as an invalid
/// configuration.
func parseSchemeAndHost(_ urlString: String) -> (scheme: String, host: String)? {
  guard
    let components = URLComponents(string: urlString),
    let scheme = components.scheme, !scheme.isEmpty,
    let host = components.host, !host.isEmpty
  else {
    return nil
  }
  return (scheme.lowercased(), host.lowercased())
}

/// Validates a backend host URL against the allowlist.
///
/// Throws `FireweaveError(kind: .configuration)` — fixed message, no host
/// echo. `initFatal` is threaded through by both call sites
/// (`initFireweave`'s sanctioned entry point, `FireweaveRemoteAdapter.initialize`'s
/// own safety-net check for direct adapter construction that bypasses
/// `initFireweave`) as `true` — a host-allowlist rejection maps to
/// `PROVIDER_FATAL`, matching node/go/java/rust
/// (`contracts/security/sec-endpoint-ssrf-allowlist.json`).
public func assertHostAllowed(_ url: String, allowedHosts: [String]?, initFatal: Bool) throws {
  guard let (scheme, hostname) = parseSchemeAndHost(url) else {
    throw FireweaveError.configuration("invalid configuration", initFatal: initFatal)
  }
  guard scheme == "http" || scheme == "https" else {
    throw FireweaveError.configuration("invalid configuration", initFatal: initFatal)
  }

  let loopback = isLoopbackHostname(hostname)
  if scheme == "http" && !loopback {
    // https required for anything that leaves the machine.
    throw FireweaveError.configuration("invalid configuration", initFatal: initFatal)
  }

  let allow: [String]
  if let hosts = allowedHosts, !hosts.isEmpty {
    allow = hosts.map { $0.lowercased() }
  } else {
    allow = defaultAllowedHosts.map { $0.lowercased() }
  }
  if allow.contains("*") { return }  // explicit opt-out
  guard allow.contains(hostname) else {
    throw FireweaveError.configuration("invalid configuration", initFatal: initFatal)
  }
}

/// Adapter-level default when the caller supplies no `allowedHosts`: the
/// URL's own hostname plus loopback (`FireweaveRemoteAdapter`'s fallback for
/// direct construction that bypasses `initFireweave`'s canonical default).
func defaultAllowedHosts(for apiUrl: String) -> [String]? {
  guard let (_, host) = parseSchemeAndHost(apiUrl) else { return nil }
  return [host, "localhost", "127.0.0.1", "::1"]
}
