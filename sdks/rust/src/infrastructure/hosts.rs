//! Backend host allowlist (SSRF guard).
//!
//! The allowlist is ON by default: when no explicit `allowed_hosts` is
//! configured, only the canonical Fireweave hosts plus loopback are
//! permitted, so a typo'd or tampered host cannot be aimed at cloud
//! metadata endpoints. Custom/self-hosted deployments require an explicit
//! `allowed_hosts` entry; `["*"]` opts out entirely.
//!
//! Scheme policy: https is required for non-loopback hosts; plain http is
//! permitted on loopback only.
//!
//! URL parsing is hand-rolled (no `url` crate — the dependency budget for
//! this SDK is exactly `ureq` + `serde` + `serde_json`); it extracts only
//! what the allowlist check needs (scheme, hostname), which is well within
//! what a handful of `str` operations can do correctly for the plain
//! `scheme://host[:port][/path]` shapes fw-server URLs and test stubs use.

use crate::domain::errors::FireweaveError;

/// Canonical default host allowlist: Fireweave's own fw-server hostnames
/// plus loopback. An unconfigured allowlist denies everything it does not
/// name.
pub const DEFAULT_ALLOWED_HOSTS: [&str; 5] = [
    "app-server.fireweave.ai",
    "staging-app-server.fireweave.ai",
    "localhost",
    "127.0.0.1",
    "::1",
];

const LOOPBACK_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "::1"];

/// True for loopback hostnames (http and test stubs are permitted here).
pub fn is_loopback_hostname(hostname: &str) -> bool {
    LOOPBACK_HOSTS.contains(&hostname)
}

/// Extracts `(scheme, hostname)` from a `scheme://host[:port][/path...]`
/// URL string. Returns `None` when the input has no `scheme://` prefix —
/// callers treat that as an invalid configuration.
fn parse_scheme_and_host(url: &str) -> Option<(String, String)> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme.is_empty() {
        return None;
    }
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let host_port = authority
        .rsplit_once('@')
        .map(|(_, h)| h)
        .unwrap_or(authority);
    let host = if let Some(stripped) = host_port.strip_prefix('[') {
        // IPv6 literal: "[::1]:port" -> "::1"
        stripped.split(']').next().unwrap_or(stripped)
    } else {
        host_port.split(':').next().unwrap_or(host_port)
    };
    if host.is_empty() {
        return None;
    }
    Some((scheme.to_string(), host.to_string()))
}

/// Extracts just the hostname, for the remote adapter's own fallback
/// allowlist (`FireweaveRemoteAdapter`'s `default_allowed_hosts_for`).
pub(crate) fn extract_hostname(url: &str) -> Option<String> {
    parse_scheme_and_host(url).map(|(_, host)| host)
}

/// Validates a backend host URL against the allowlist.
///
/// Returns `Err(Configuration)` — fixed message, no host echo. Both call
/// sites (`application::mode::init_fireweave`'s sanctioned entry point,
/// `infrastructure::adapters::remote::FireweaveRemoteAdapter::initialize`)
/// run only during initialisation, so `init_fatal` is threaded through
/// unconditionally by both callers — a host-allowlist rejection maps to
/// `PROVIDER_FATAL`, matching node/go/java
/// (`contracts/security/sec-endpoint-ssrf-allowlist.json`).
pub fn assert_host_allowed(
    host: &str,
    allowed_hosts: Option<&[String]>,
    init_fatal: bool,
) -> Result<(), FireweaveError> {
    let (scheme, hostname) = match parse_scheme_and_host(host) {
        Some(parsed) => parsed,
        None => {
            return Err(FireweaveError::configuration(
                "invalid configuration",
                init_fatal,
            ))
        }
    };
    let scheme = scheme.to_lowercase();
    let hostname = hostname.to_lowercase();
    if (scheme != "http" && scheme != "https") || hostname.is_empty() {
        return Err(FireweaveError::configuration(
            "invalid configuration",
            init_fatal,
        ));
    }

    let loopback = is_loopback_hostname(&hostname);
    if scheme == "http" && !loopback {
        // https required for anything that leaves the machine.
        return Err(FireweaveError::configuration(
            "invalid configuration",
            init_fatal,
        ));
    }

    let allow: Vec<String> = match allowed_hosts {
        Some(hosts) if !hosts.is_empty() => hosts.iter().map(|h| h.to_lowercase()).collect(),
        _ => DEFAULT_ALLOWED_HOSTS
            .iter()
            .map(|h| h.to_lowercase())
            .collect(),
    };
    if allow.iter().any(|h| h == "*") {
        return Ok(()); // explicit opt-out
    }
    if !allow.iter().any(|h| h == &hostname) {
        return Err(FireweaveError::configuration(
            "invalid configuration",
            init_fatal,
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_http_is_allowed_by_default() {
        assert!(assert_host_allowed("http://127.0.0.1:3901", None, true).is_ok());
        assert!(assert_host_allowed("http://localhost:3901", None, true).is_ok());
    }

    #[test]
    fn canonical_https_host_is_allowed_by_default() {
        assert!(assert_host_allowed("https://app-server.fireweave.ai", None, true).is_ok());
    }

    #[test]
    fn non_loopback_http_is_rejected() {
        let err = assert_host_allowed("http://example.com", None, true).unwrap_err();
        assert_eq!(err.message, "invalid configuration");
    }

    #[test]
    fn host_outside_allowlist_is_rejected_even_with_explicit_list() {
        let allow = vec![
            "127.0.0.1".to_string(),
            "localhost".to_string(),
            "us.i.posthog.com".to_string(),
        ];
        assert!(assert_host_allowed("http://169.254.169.254", Some(&allow), true).is_err());
    }

    #[test]
    fn wildcard_opts_out_explicitly() {
        let allow = vec!["*".to_string()];
        assert!(assert_host_allowed("https://anything.example.com", Some(&allow), true).is_ok());
    }

    #[test]
    fn malformed_url_is_rejected() {
        assert!(assert_host_allowed("not-a-uri", None, true).is_err());
    }

    #[test]
    fn extracts_ipv6_hostname() {
        assert_eq!(
            extract_hostname("http://[::1]:8080/x"),
            Some("::1".to_string())
        );
    }
}
