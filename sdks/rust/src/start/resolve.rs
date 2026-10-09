//! The pure start-profile resolver: options + env lookup + build channel
//! in, one resolved config out. No I/O and no globals, so every rule here is
//! unit-tested through `resolve` alone (node: `src/start/resolve.ts`, go:
//! `fw/resolve.go`).
//!
//! Precedence for every value: explicit `StartOptions` field, then the
//! `FIREWEAVE_*` variable, then the legacy `FW_*` name (one warning), then
//! the default. Lookups are lazy: a source is read only if every earlier
//! source was unset.

use crate::{is_loopback_hostname, FireweaveError, Mode};

use super::channel::Channel;
use super::control_points::LocalControlPoints;
use super::names::{
    DEV_ENVIRONMENTS, ENVIRONMENT_FALLBACKS, ENV_ENVIRONMENT, ENV_KEY, ENV_URL, LEGACY_KEY_NAMES,
    LEGACY_URL_NAMES, LOOPBACK_HOSTS, OPT_ENVIRONMENT, OPT_KEY, OPT_URL, RETIRED_ENVIRONMENT_NAME,
};
use super::options::StartOptions;

/// Why a mode was chosen (`Status::mode_source`).
pub(crate) const MODE_SOURCE_OPTION: &str = "option";
pub(crate) const MODE_SOURCE_KEY: &str = "key";
pub(crate) const MODE_SOURCE_ENVIRONMENT: &str = "environment";

/// The SDK build the resolver defaults from.
#[derive(Clone)]
pub(crate) struct BuildInfo {
    pub(crate) version: String,
    pub(crate) channel: Channel,
}

/// One start decision. `key` is held only to hand it to the core; it is
/// never logged, printed or put in a status. No `Debug` impl, so it cannot
/// be printed by accident.
#[derive(Clone)]
pub(crate) struct Resolved {
    pub(crate) mode: Mode,
    pub(crate) mode_source: &'static str,

    // Remote only.
    pub(crate) url: Option<String>,
    pub(crate) url_source: Option<String>,
    /// `None` when the default channel endpoint is used (the core's default
    /// allowlist already admits both channel hosts).
    pub(crate) allowed_hosts: Option<Vec<String>>,
    pub(crate) host: Option<String>,
    pub(crate) key: Option<String>,
    /// `"none"` in local mode.
    pub(crate) key_source: String,

    // Set when the environment name chose local mode.
    pub(crate) environment: Option<String>,
    pub(crate) environment_source: Option<String>,

    pub(crate) control_points: LocalControlPoints,
    pub(crate) channel: Channel,
    pub(crate) sdk_version: String,

    /// Lines to log once each: legacy names, an ignored key.
    pub(crate) warnings: Vec<String>,
}

struct Sourced {
    value: String,
    source: String,
}

pub(crate) fn config_error(message: impl AsRef<str>) -> FireweaveError {
    FireweaveError::configuration(message, true)
}

/// The first set value of: the option, then each env name in order, then
/// each legacy name (adding one warning naming its replacement).
fn pick(
    option: Option<&str>,
    option_name: &str,
    names: &[&str],
    legacy: &[&str],
    lookup: &dyn Fn(&str) -> Option<String>,
    warnings: Option<&mut Vec<String>>,
    replacement: &str,
) -> Option<Sourced> {
    if let Some(v) = option.map(str::trim).filter(|v| !v.is_empty()) {
        return Some(Sourced {
            value: v.to_string(),
            source: option_name.to_string(),
        });
    }
    for name in names {
        if let Some(value) = lookup(name) {
            return Some(Sourced {
                value,
                source: (*name).to_string(),
            });
        }
    }
    for name in legacy {
        if let Some(value) = lookup(name) {
            if let Some(warnings) = warnings {
                warnings.push(format!(
                    "[fireweave] {name} is a legacy name and will stop being read in the next major version (3.0). Rename it to {replacement}; the value does not change."
                ));
            }
            return Some(Sourced {
                value,
                source: (*name).to_string(),
            });
        }
    }
    None
}

/// Analytics-vendor key shape: `ph` + one lowercase letter + `_`. A shape
/// rather than literal prefixes, and messages say "analytics vendor key",
/// so no vendor key prefix appears in this module or in an error.
fn is_vendor_key(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() >= 4 && b[0] == b'p' && b[1] == b'h' && b[2].is_ascii_lowercase() && b[3] == b'_'
}

/// Runs before any request. Messages name the source, never the value.
/// (The core's redactor blanks only `FW_PROJECT_API_KEY=`/`:` assignments,
/// so naming that variable as a source survives it; the tests pin that
/// every message is a fixed point of `redact_secrets`.)
pub(crate) fn key_family_error(key: &str, source: &str) -> Option<FireweaveError> {
    let message = if key.starts_with("fw_public_") {
        format!("The key from {source} is a browser key (fw_public_…). Server apps need a project key (project-api-key_…) from Project settings, API keys.")
    } else if is_vendor_key(key) {
        format!("The key from {source} is an analytics vendor key, not a FireWeave project key. Use the project key (project-api-key_…).")
    } else if key.starts_with("fw_org_") || key.starts_with("cli_at_") {
        format!("The key from {source} is an organisation or CLI token, not a project key. Use the project key (project-api-key_…).")
    } else {
        return None;
    };
    Some(config_error(message))
}

/// `(scheme, host, port)` of a `scheme://[userinfo@]host[:port][/path]` URL,
/// lowercased scheme and host. `None` when it is not that shape. The core's
/// own parser is crate-private, so the start profile carries this small one
/// (the core still re-checks the result with `assert_host_allowed`).
pub(crate) fn parse_url(url: &str) -> Option<(String, String)> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme.is_empty() || !scheme.bytes().all(|b| b.is_ascii_alphabetic()) {
        return None;
    }
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let host_port = authority
        .rsplit_once('@')
        .map(|(_, h)| h)
        .unwrap_or(authority);
    let (host, port) = if let Some(stripped) = host_port.strip_prefix('[') {
        let (host, after) = stripped.split_once(']')?;
        (host, after.strip_prefix(':'))
    } else {
        match host_port.split_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (host_port, None),
        }
    };
    if host.is_empty() || host.chars().any(|c| c.is_whitespace()) {
        return None;
    }
    if let Some(port) = port {
        if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
    }
    Some((scheme.to_ascii_lowercase(), host.to_ascii_lowercase()))
}

struct ResolvedUrl {
    url: String,
    source: String,
    host: String,
    allowed_hosts: Option<Vec<String>>,
}

/// The endpoint. The default is this build's channel host, which the core's
/// default allowlist already admits; an override gets an allowlist of its
/// own host plus loopback.
fn resolve_url(
    options: &StartOptions,
    lookup: &dyn Fn(&str) -> Option<String>,
    build: &BuildInfo,
    warnings: &mut Vec<String>,
) -> Result<ResolvedUrl, FireweaveError> {
    let Some(picked) = pick(
        options.url.as_deref(),
        OPT_URL,
        &[ENV_URL],
        &LEGACY_URL_NAMES,
        lookup,
        Some(warnings),
        ENV_URL,
    ) else {
        let url = build.channel.default_url().to_string();
        let host = parse_url(&url).map(|(_, h)| h).unwrap_or_default();
        return Ok(ResolvedUrl {
            url,
            source: format!("SDK channel ({})", build.channel),
            host,
            allowed_hosts: None,
        });
    };
    let raw = picked.value.trim_end_matches('/').to_string();
    let Some((scheme, host)) = parse_url(&raw).filter(|(s, _)| s == "http" || s == "https") else {
        return Err(config_error(format!(
            "The endpoint from {} is not a valid http or https URL.",
            picked.source
        )));
    };
    if scheme == "http" && !is_loopback_hostname(&host) {
        return Err(config_error(format!(
            "The endpoint from {} must use https (http is allowed only for localhost).",
            picked.source
        )));
    }
    let mut hosts = vec![host.clone()];
    for h in LOOPBACK_HOSTS {
        if h != host {
            hosts.push(h.to_string());
        }
    }
    Ok(ResolvedUrl {
        url: raw,
        source: picked.source,
        host,
        allowed_hosts: Some(hosts),
    })
}

fn resolve_key(
    options: &StartOptions,
    lookup: &dyn Fn(&str) -> Option<String>,
    warnings: &mut Vec<String>,
) -> Result<Option<Sourced>, FireweaveError> {
    let Some(picked) = pick(
        options.key.as_deref(),
        OPT_KEY,
        &[ENV_KEY],
        &LEGACY_KEY_NAMES,
        lookup,
        Some(warnings),
        ENV_KEY,
    ) else {
        return Ok(None);
    };
    if let Some(err) = key_family_error(&picked.value, &picked.source) {
        return Err(err);
    }
    Ok(Some(picked))
}

/// Whether an environment name may be quoted back in an error: a short plain
/// token that does not look like a key.
fn echoable(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
        && !is_vendor_key(value)
        && !value.starts_with("project-api-key_")
        && !value.starts_with("fw_")
}

fn environment_names() -> Vec<&'static str> {
    let mut names = vec![ENV_ENVIRONMENT];
    names.extend(ENVIRONMENT_FALLBACKS);
    names
}

fn no_key_error(
    environment: Option<&Sourced>,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> FireweaveError {
    let where_ = match environment {
        None => format!(
            "no environment name is set (checked {OPT_ENVIRONMENT}, {})",
            environment_names().join(", ")
        ),
        Some(env) if echoable(&env.value) => format!(
            "the environment is {:?} (from {}), which is not a development name",
            env.value, env.source
        ),
        Some(env) => format!(
            "the environment name from {} is not a development name",
            env.source
        ),
    };
    let retired = if environment.is_none() && lookup(RETIRED_ENVIRONMENT_NAME).is_some() {
        format!(" {RETIRED_ENVIRONMENT_NAME} is no longer read; rename it to {ENV_ENVIRONMENT}.")
    } else {
        String::new()
    };
    config_error(format!(
        "{ENV_KEY} is not set and {where_}. Set {ENV_KEY} to the project's server key, or for local development set {ENV_ENVIRONMENT} to development or pass StartOptions.mode Some(Mode::Local).{retired}"
    ))
}

fn is_dev_environment(name: &str) -> bool {
    DEV_ENVIRONMENTS
        .iter()
        .any(|d| d.eq_ignore_ascii_case(name.trim()))
}

/// Applies the start profile's rules to `options`. Returns a
/// `Configuration` error naming the source at fault, never a value.
pub(crate) fn resolve(
    options: &StartOptions,
    lookup: &dyn Fn(&str) -> Option<String>,
    build: &BuildInfo,
) -> Result<Resolved, FireweaveError> {
    let mut r = Resolved {
        mode: Mode::Local,
        mode_source: MODE_SOURCE_OPTION,
        url: None,
        url_source: None,
        allowed_hosts: None,
        host: None,
        key: None,
        key_source: "none".to_string(),
        environment: None,
        environment_source: None,
        control_points: options.control_points.clone(),
        channel: build.channel,
        sdk_version: build.version.clone(),
        warnings: Vec::new(),
    };

    if options.mode == Some(Mode::Local) {
        // The key is ignored. Look only to warn.
        if let Some(src) = pick(
            options.key.as_deref(),
            OPT_KEY,
            &[ENV_KEY],
            &LEGACY_KEY_NAMES,
            lookup,
            None,
            ENV_KEY,
        ) {
            r.warnings.push(format!(
                "[fireweave] StartOptions.mode Local ignores the key from {}; nothing is sent to fw-server.",
                src.source
            ));
        }
        return Ok(r);
    }

    let key = resolve_key(options, lookup, &mut r.warnings)?;

    let Some(key) = key else {
        if options.mode == Some(Mode::Remote) {
            return Err(config_error(format!(
                "StartOptions.mode Remote needs a key. Set {ENV_KEY} or pass {OPT_KEY}."
            )));
        }
        let environment = pick(
            options.environment.as_deref(),
            OPT_ENVIRONMENT,
            &environment_names(),
            &[],
            lookup,
            None,
            ENV_ENVIRONMENT,
        );
        return match environment {
            Some(env) if is_dev_environment(&env.value) => {
                r.mode_source = MODE_SOURCE_ENVIRONMENT;
                r.environment = Some(env.value);
                r.environment_source = Some(env.source);
                Ok(r)
            }
            other => Err(no_key_error(other.as_ref(), lookup)),
        };
    };

    let url = resolve_url(options, lookup, build, &mut r.warnings)?;
    r.mode = Mode::Remote;
    r.mode_source = if options.mode == Some(Mode::Remote) {
        MODE_SOURCE_OPTION
    } else {
        MODE_SOURCE_KEY
    };
    r.url = Some(url.url);
    r.url_source = Some(url.source);
    r.host = Some(url.host);
    r.allowed_hosts = url.allowed_hosts;
    r.key = Some(key.value);
    r.key_source = key.source;
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{assert_host_allowed, redact_secrets, ErrorKind};
    use std::cell::RefCell;
    use std::collections::HashMap;

    use crate::start::{define_control_points, LocalControlPoint};

    const TEST_KEY: &str = "project-api-key_abc123";

    fn prod() -> BuildInfo {
        BuildInfo {
            version: "2.4.0".to_string(),
            channel: Channel::Production,
        }
    }

    fn staging() -> BuildInfo {
        BuildInfo {
            version: "2.4.0-staging.3".to_string(),
            channel: Channel::Staging,
        }
    }

    /// An analytics-vendor key prefix, built rather than written as a
    /// literal (the core redactor matches the literal prefixes).
    fn vendor_prefix(letter: char) -> String {
        format!("ph{letter}_")
    }

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.trim().to_string()))
            .filter(|(_, v)| !v.is_empty())
            .collect();
        move |name: &str| map.get(name).cloned()
    }

    fn opts() -> StartOptions {
        StartOptions::default()
    }

    fn ok(options: &StartOptions, lookup: &dyn Fn(&str) -> Option<String>) -> Resolved {
        match resolve(options, lookup, &prod()) {
            Ok(r) => r,
            Err(e) => panic!("resolve: {e}"),
        }
    }

    /// Asserts a Configuration error and returns its message, which must be
    /// a fixed point of the core redactor (so it reaches the user intact).
    fn config_message(
        options: &StartOptions,
        lookup: &dyn Fn(&str) -> Option<String>,
        build: &BuildInfo,
    ) -> String {
        let err = match resolve(options, lookup, build) {
            Ok(_) => panic!("expected a Configuration error"),
            Err(e) => e,
        };
        assert_eq!(err.kind, ErrorKind::Configuration);
        assert!(err.init_fatal);
        assert_eq!(err.openfeature_error_code(), "PROVIDER_FATAL");
        assert_eq!(redact_secrets(&err.message), err.message);
        err.message
    }

    // ------------------------------------------------------- mode: explicit

    #[test]
    fn mode_remote_with_key_is_remote() {
        let o = StartOptions {
            mode: Some(Mode::Remote),
            key: Some(TEST_KEY.into()),
            ..opts()
        };
        let r = ok(&o, &env(&[("FIREWEAVE_ENV", "development")]));
        assert_eq!(r.mode, Mode::Remote);
        assert_eq!(r.mode_source, MODE_SOURCE_OPTION);
        assert_eq!(r.key_source, OPT_KEY);
    }

    #[test]
    fn mode_remote_without_a_key_names_fireweave_key() {
        let o = StartOptions {
            mode: Some(Mode::Remote),
            ..opts()
        };
        let msg = config_message(&o, &env(&[("FIREWEAVE_ENV", "development")]), &prod());
        assert!(msg.contains("FIREWEAVE_KEY"), "{msg}");
        assert!(msg.contains("StartOptions.mode Remote"), "{msg}");
    }

    #[test]
    fn mode_local_ignores_a_key_with_a_warning() {
        let o = StartOptions {
            mode: Some(Mode::Local),
            ..opts()
        };
        let r = ok(&o, &env(&[("FIREWEAVE_KEY", TEST_KEY)]));
        assert_eq!(r.mode, Mode::Local);
        assert_eq!(r.mode_source, MODE_SOURCE_OPTION);
        assert!(r.key.is_none());
        assert_eq!(r.key_source, "none");
        assert_eq!(r.warnings.len(), 1);
        assert!(r.warnings[0].contains("ignores the key from FIREWEAVE_KEY"));
        assert!(!r.warnings[0].contains(TEST_KEY));

        // An explicit key option is ignored the same way, and no URL or
        // environment is consulted.
        let o = StartOptions {
            mode: Some(Mode::Local),
            key: Some(TEST_KEY.into()),
            url: Some("not a url".into()),
            ..opts()
        };
        let r = ok(&o, &env(&[]));
        assert!(r.warnings[0].contains("ignores the key from StartOptions.key"));
        assert!(r.url.is_none());
    }

    #[test]
    fn mode_local_needs_no_environment_name() {
        let o = StartOptions {
            mode: Some(Mode::Local),
            ..opts()
        };
        let r = ok(&o, &env(&[("APP_ENV", "production")]));
        assert_eq!(r.mode, Mode::Local);
        assert!(r.warnings.is_empty());
    }

    // ------------------------------------------------------- mode: inferred

    #[test]
    fn a_key_means_remote_whatever_the_environment_says() {
        for environment in ["development", "production", ""] {
            let r = ok(
                &opts(),
                &env(&[("FIREWEAVE_KEY", TEST_KEY), ("FIREWEAVE_ENV", environment)]),
            );
            assert_eq!(r.mode, Mode::Remote);
            assert_eq!(r.mode_source, MODE_SOURCE_KEY);
            assert!(r.environment.is_none());
        }
    }

    #[test]
    fn no_key_and_a_dev_environment_means_local() {
        for name in [
            "development",
            "dev",
            "local",
            "test",
            " Development ",
            "TEST",
        ] {
            let r = ok(&opts(), &env(&[("FIREWEAVE_ENV", name)]));
            assert_eq!(r.mode, Mode::Local, "{name}");
            assert_eq!(r.mode_source, MODE_SOURCE_ENVIRONMENT);
            assert_eq!(r.environment.as_deref(), Some(name.trim()));
            assert_eq!(r.environment_source.as_deref(), Some("FIREWEAVE_ENV"));
        }
        let r = ok(&opts(), &env(&[("APP_ENV", "dev")]));
        assert_eq!(r.environment_source.as_deref(), Some("APP_ENV"));
    }

    #[test]
    fn the_environment_option_beats_the_variables() {
        let o = StartOptions {
            environment: Some("local".into()),
            ..opts()
        };
        let r = ok(&o, &env(&[("FIREWEAVE_ENV", "production")]));
        assert_eq!(r.environment_source.as_deref(), Some(OPT_ENVIRONMENT));
    }

    #[test]
    fn fireweave_env_beats_app_env() {
        let msg = config_message(
            &opts(),
            &env(&[("FIREWEAVE_ENV", "production"), ("APP_ENV", "dev")]),
            &prod(),
        );
        assert!(msg.contains("\"production\" (from FIREWEAVE_ENV)"), "{msg}");
        let r = ok(
            &opts(),
            &env(&[("FIREWEAVE_ENV", "dev"), ("APP_ENV", "production")]),
        );
        assert_eq!(r.environment_source.as_deref(), Some("FIREWEAVE_ENV"));
    }

    #[test]
    fn node_env_and_fw_env_are_not_environment_names() {
        let msg = config_message(&opts(), &env(&[("NODE_ENV", "development")]), &prod());
        assert!(msg.contains("no environment name is set"), "{msg}");
    }

    #[test]
    fn no_key_and_a_non_dev_environment_fails_closed() {
        for name in ["production", "staging", "prod"] {
            let msg = config_message(&opts(), &env(&[("APP_ENV", name)]), &prod());
            assert!(msg.starts_with("FIREWEAVE_KEY is not set"), "{msg}");
            assert!(msg.contains("not a development name"), "{msg}");
        }
    }

    #[test]
    fn no_key_and_no_environment_fails_closed_naming_where_it_looked() {
        let msg = config_message(&opts(), &env(&[]), &prod());
        assert!(msg.contains("FIREWEAVE_KEY is not set"), "{msg}");
        assert!(
            msg.contains("checked StartOptions.environment, FIREWEAVE_ENV, APP_ENV"),
            "{msg}"
        );
        assert!(!msg.contains("FW_ENV is no longer read"), "{msg}");
    }

    #[test]
    fn points_at_fireweave_env_when_only_fw_env_is_set() {
        let msg = config_message(&opts(), &env(&[("FW_ENV", "development")]), &prod());
        assert!(
            msg.contains("FW_ENV is no longer read; rename it to FIREWEAVE_ENV."),
            "{msg}"
        );
    }

    #[test]
    fn empty_and_whitespace_count_as_unset() {
        let o = StartOptions {
            key: Some("   ".into()),
            environment: Some("".into()),
            url: Some(" ".into()),
            ..opts()
        };
        let r = ok(&o, &env(&[("FIREWEAVE_KEY", "  "), ("APP_ENV", " dev ")]));
        assert_eq!(r.mode, Mode::Local);
        assert_eq!(r.environment.as_deref(), Some("dev"));
    }

    #[test]
    fn never_echoes_a_key_shaped_environment_name() {
        for value in [
            "project-api-key_leaked".to_string(),
            format!("{}leaked", vendor_prefix('c')),
            "fw_public_leaked".to_string(),
            "way-too-long-to-be-an-environment-name-at-all".to_string(),
            "has space".to_string(),
        ] {
            let msg = config_message(&opts(), &env(&[("FIREWEAVE_ENV", &value)]), &prod());
            assert!(!msg.contains("leaked"), "{msg}");
            assert!(
                msg.contains("the environment name from FIREWEAVE_ENV is not a development name"),
                "{msg}"
            );
        }
    }

    // ------------------------------------------------------------ endpoint

    #[test]
    fn a_production_build_calls_app_server() {
        let r = ok(&opts(), &env(&[("FIREWEAVE_KEY", TEST_KEY)]));
        assert_eq!(r.url.as_deref(), Some("https://app-server.fireweave.ai"));
        assert_eq!(r.url_source.as_deref(), Some("SDK channel (production)"));
        assert_eq!(r.host.as_deref(), Some("app-server.fireweave.ai"));
        assert!(r.allowed_hosts.is_none());
    }

    #[test]
    fn a_staging_build_calls_staging_app_server() {
        let r = resolve(&opts(), &env(&[("FIREWEAVE_KEY", TEST_KEY)]), &staging())
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            r.url.as_deref(),
            Some("https://staging-app-server.fireweave.ai")
        );
        assert_eq!(r.url_source.as_deref(), Some("SDK channel (staging)"));
        assert_eq!(r.channel, Channel::Staging);
        assert_eq!(r.sdk_version, "2.4.0-staging.3");
    }

    #[test]
    fn both_channel_hosts_pass_the_core_default_allowlist() {
        for channel in [Channel::Production, Channel::Staging] {
            assert!(assert_host_allowed(channel.default_url(), None, true).is_ok());
            assert!(crate::DEFAULT_ALLOWED_HOSTS
                .contains(&parse_url(channel.default_url()).unwrap().1.as_str()));
        }
    }

    #[test]
    fn the_url_option_wins_and_the_allowlist_follows_it() {
        let o = StartOptions {
            url: Some("https://fw.example.com/".into()),
            ..opts()
        };
        let r = ok(
            &o,
            &env(&[
                ("FIREWEAVE_KEY", TEST_KEY),
                ("FIREWEAVE_URL", "https://other.example.com"),
            ]),
        );
        assert_eq!(r.url.as_deref(), Some("https://fw.example.com"));
        assert_eq!(r.url_source.as_deref(), Some(OPT_URL));
        assert_eq!(
            r.allowed_hosts,
            Some(vec![
                "fw.example.com".to_string(),
                "localhost".to_string(),
                "127.0.0.1".to_string(),
                "::1".to_string()
            ])
        );
        let hosts = r.allowed_hosts.unwrap();
        assert!(assert_host_allowed(r.url.as_deref().unwrap(), Some(&hosts), true).is_ok());
    }

    #[test]
    fn fireweave_url_beats_the_legacy_names() {
        let r = ok(
            &opts(),
            &env(&[
                ("FIREWEAVE_KEY", TEST_KEY),
                ("FIREWEAVE_URL", "https://new.example.com"),
                ("FW_API_URL", "https://old.example.com"),
            ]),
        );
        assert_eq!(r.url.as_deref(), Some("https://new.example.com"));
        assert!(r.warnings.is_empty());
    }

    #[test]
    fn legacy_url_names_are_read_in_order_with_a_warning() {
        let r = ok(
            &opts(),
            &env(&[
                ("FIREWEAVE_KEY", TEST_KEY),
                ("FW_API_URL", "https://api.example.com"),
                ("FW_ATTEST_URL", "https://attest.example.com"),
            ]),
        );
        assert_eq!(r.url.as_deref(), Some("https://api.example.com"));
        assert_eq!(r.url_source.as_deref(), Some("FW_API_URL"));
        assert_eq!(r.warnings.len(), 1);
        assert!(r.warnings[0].contains("FW_API_URL is a legacy name"));
        assert!(r.warnings[0].contains("Rename it to FIREWEAVE_URL"));

        let r = ok(
            &opts(),
            &env(&[
                ("FIREWEAVE_KEY", TEST_KEY),
                ("FW_ATTEST_URL", "https://attest.example.com"),
            ]),
        );
        assert_eq!(r.url_source.as_deref(), Some("FW_ATTEST_URL"));
    }

    #[test]
    fn http_is_allowed_on_loopback_only() {
        for url in [
            "http://localhost:3000",
            "http://127.0.0.1:8080/",
            "http://[::1]:9",
        ] {
            let o = StartOptions {
                url: Some(url.into()),
                key: Some(TEST_KEY.into()),
                ..opts()
            };
            let r = ok(&o, &env(&[]));
            assert_eq!(r.mode, Mode::Remote, "{url}");
        }
        let o = StartOptions {
            url: Some("http://fw.example.com".into()),
            key: Some(TEST_KEY.into()),
            ..opts()
        };
        let msg = config_message(&o, &env(&[]), &prod());
        assert!(
            msg.contains("from StartOptions.url must use https"),
            "{msg}"
        );
        assert!(!msg.contains("fw.example.com"), "{msg}");
    }

    #[test]
    fn an_invalid_url_names_its_source_and_never_echoes_it() {
        for url in [
            "fw.example.com",
            "ftp://fw.example.com",
            "https://",
            "https://host:port",
            "https://ho st",
        ] {
            let msg = config_message(
                &opts(),
                &env(&[("FIREWEAVE_KEY", TEST_KEY), ("FIREWEAVE_URL", url)]),
                &prod(),
            );
            assert!(msg.contains("from FIREWEAVE_URL is not a valid"), "{msg}");
            assert!(!msg.contains("example"), "{msg}");
        }
    }

    #[test]
    fn local_mode_resolves_no_endpoint() {
        let r = ok(
            &opts(),
            &env(&[("FIREWEAVE_ENV", "dev"), ("FIREWEAVE_URL", "not a url")]),
        );
        assert_eq!(r.mode, Mode::Local);
        assert!(r.url.is_none() && r.host.is_none() && r.allowed_hosts.is_none());
    }

    // ----------------------------------------------------------------- key

    #[test]
    fn the_key_option_beats_fireweave_key() {
        let o = StartOptions {
            key: Some("project-api-key_option".into()),
            ..opts()
        };
        let r = ok(&o, &env(&[("FIREWEAVE_KEY", TEST_KEY)]));
        assert_eq!(r.key.as_deref(), Some("project-api-key_option"));
        assert_eq!(r.key_source, OPT_KEY);
    }

    #[test]
    fn with_the_key_option_no_key_or_environment_variable_is_read() {
        let reads = RefCell::new(Vec::new());
        let lookup = |name: &str| {
            reads.borrow_mut().push(name.to_string());
            None
        };
        let o = StartOptions {
            key: Some(TEST_KEY.into()),
            ..opts()
        };
        let _ = ok(&o, &lookup);
        let reads = reads.into_inner();
        assert_eq!(reads, vec!["FIREWEAVE_URL", "FW_API_URL", "FW_ATTEST_URL"]);
    }

    #[test]
    fn fireweave_key_beats_the_legacy_name() {
        let r = ok(
            &opts(),
            &env(&[
                ("FIREWEAVE_KEY", TEST_KEY),
                ("FW_PROJECT_API_KEY", "project-api-key_old"),
            ]),
        );
        assert_eq!(r.key.as_deref(), Some(TEST_KEY));
        assert_eq!(r.key_source, "FIREWEAVE_KEY");
        assert!(r.warnings.is_empty());
    }

    #[test]
    fn the_legacy_project_key_is_read_with_a_warning() {
        let r = ok(&opts(), &env(&[("FW_PROJECT_API_KEY", TEST_KEY)]));
        assert_eq!(r.mode, Mode::Remote);
        assert_eq!(r.key_source, "FW_PROJECT_API_KEY");
        assert_eq!(r.warnings.len(), 1);
        assert!(r.warnings[0].contains("FW_PROJECT_API_KEY is a legacy name"));
        assert!(r.warnings[0].contains("Rename it to FIREWEAVE_KEY"));
        assert!(!r.warnings[0].contains(TEST_KEY));
    }

    #[test]
    fn a_browser_key_is_rejected_without_printing_it() {
        let msg = config_message(
            &opts(),
            &env(&[("FIREWEAVE_KEY", "fw_public_secretvalue")]),
            &prod(),
        );
        assert!(
            msg.contains("The key from FIREWEAVE_KEY is a browser key"),
            "{msg}"
        );
        assert!(!msg.contains("secretvalue"), "{msg}");
    }

    #[test]
    fn vendor_org_and_cli_keys_are_rejected() {
        for letter in ['c', 's', 'x', 'q'] {
            let key = format!("{}secretvalue", vendor_prefix(letter));
            let msg = config_message(&opts(), &env(&[("FIREWEAVE_KEY", &key)]), &prod());
            assert!(msg.contains("analytics vendor key"), "{msg}");
            assert!(!msg.contains("secretvalue"), "{msg}");
        }
        for key in ["fw_org_secretvalue", "cli_at_secretvalue"] {
            let o = StartOptions {
                key: Some(key.into()),
                ..opts()
            };
            let msg = config_message(&o, &env(&[]), &prod());
            assert!(
                msg.contains("The key from StartOptions.key is an organisation or CLI token"),
                "{msg}"
            );
            assert!(!msg.contains("secretvalue"), "{msg}");
        }
        // Not the vendor shape: an upper-case third letter, or no underscore.
        assert!(!is_vendor_key("phC_x"));
        assert!(!is_vendor_key("phc"));
        assert!(!is_vendor_key("ph"));
    }

    #[test]
    fn the_legacy_key_source_stays_legible_in_an_error() {
        let msg = config_message(
            &opts(),
            &env(&[("FW_PROJECT_API_KEY", "fw_public_secretvalue")]),
            &prod(),
        );
        assert!(
            msg.contains("The key from FW_PROJECT_API_KEY is a browser key"),
            "{msg}"
        );
        assert!(!msg.contains("[REDACTED]"), "{msg}");
    }

    #[test]
    fn a_project_key_passes_the_family_check() {
        assert!(key_family_error(TEST_KEY, "FIREWEAVE_KEY").is_none());
        assert!(key_family_error("fw_ingest_pub_abc", "FIREWEAVE_KEY").is_none());
    }

    // ------------------------------------------------------- control points

    #[test]
    fn the_flags_are_carried_in_both_modes() {
        let o = StartOptions {
            control_points: define_control_points([("a", LocalControlPoint::local(true))]),
            ..opts()
        };
        let r = ok(&o, &env(&[("FIREWEAVE_ENV", "dev")]));
        assert_eq!(r.control_points.len(), 1);
        let r = ok(&o, &env(&[("FIREWEAVE_KEY", TEST_KEY)]));
        assert_eq!(r.control_points.len(), 1);
    }

    #[test]
    fn parse_url_shapes() {
        assert_eq!(
            parse_url("HTTPS://User:pw@Fw.Example.com:443/x?y#z"),
            Some(("https".to_string(), "fw.example.com".to_string()))
        );
        assert_eq!(
            parse_url("http://[::1]:8080"),
            Some(("http".to_string(), "::1".to_string()))
        );
        assert_eq!(parse_url("http://[::1"), None);
        assert_eq!(parse_url("://host"), None);
    }
}
