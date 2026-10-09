//! [`StartOptions`]: everything [`super::start`] can be told. Every field is
//! optional; `StartOptions::default()` reads everything from the
//! environment.

use std::sync::Arc;

use crate::Mode;

use super::control_points::LocalControlPoints;

/// Reads one variable instead of the process environment. Return `None` for
/// an unset variable and apply no defaults of your own.
pub type EnvFn = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Receives every `[fireweave]` / `[fireweave:local]` line: warnings, the
/// local-mode line and the local `register_target` trace.
pub type LogFn = Arc<dyn Fn(&str) + Send + Sync>;

/// Options for [`super::start`].
///
/// ```
/// use fireweave::start::{define_control_points, LocalControlPoint, StartOptions};
/// use fireweave::Mode;
///
/// let options = StartOptions {
///     control_points: define_control_points([("new-checkout", LocalControlPoint::local(true))]),
///     mode: Some(Mode::Local),
///     ..Default::default()
/// };
/// assert_eq!(options.control_points.len(), 1);
/// ```
#[derive(Default, Clone)]
pub struct StartOptions {
    /// Every control point the app reads, with its local value
    /// (`src/fireweave_control_points.rs` by convention). Applied in local mode only.
    pub control_points: LocalControlPoints,
    /// Forces a mode. `None`: a key means remote; no key means local only
    /// when the environment name is `development`, `dev`, `local` or `test`.
    pub mode: Option<Mode>,
    /// The environment name used to infer the mode, instead of
    /// `FIREWEAVE_ENV` or `APP_ENV`. Pass your own, e.g. a deploy-stage
    /// setting.
    pub environment: Option<String>,
    /// The fw-server endpoint. Default: `FIREWEAVE_URL`, else this crate
    /// build's channel host. https is required except on loopback.
    pub url: Option<String>,
    /// The project key (`project-api-key_…`). Default: `FIREWEAVE_KEY`.
    pub key: Option<String>,
    /// The value of [`super::instance_key`]. Default:
    /// `FIREWEAVE_INSTANCE_ID`, else `inst_` + a hash of the host name.
    pub instance_id: Option<String>,
    /// Replaces the process environment for every variable the start
    /// profile reads (tests, `run(getenv)`-style apps). See [`env_map`].
    pub env: Option<EnvFn>,
    /// Where `[fireweave]` lines go. Default: standard error. Not part of
    /// the idempotency check.
    pub log: Option<LogFn>,
}

impl std::fmt::Debug for StartOptions {
    /// Never prints the key or the closures.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StartOptions")
            .field("control_points", &self.control_points)
            .field("mode", &self.mode)
            .field("environment", &self.environment)
            .field("url", &self.url)
            .field("key", &self.key.as_ref().map(|_| "<redacted>"))
            .field("instance_id", &self.instance_id)
            .field("env", &self.env.as_ref().map(|_| "<fn>"))
            .field("log", &self.log.as_ref().map(|_| "<fn>"))
            .finish()
    }
}

/// An [`EnvFn`] over fixed name/value pairs, for tests and apps that load
/// their configuration from somewhere other than the process environment.
///
/// ```
/// use fireweave::start::{env_map, StartOptions};
///
/// let options = StartOptions {
///     env: Some(env_map([("FIREWEAVE_ENV", "development")])),
///     ..Default::default()
/// };
/// # let _ = options;
/// ```
pub fn env_map<I, K, V>(pairs: I) -> EnvFn
where
    I: IntoIterator<Item = (K, V)>,
    K: Into<String>,
    V: Into<String>,
{
    let map: std::collections::HashMap<String, String> = pairs
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect();
    Arc::new(move |name: &str| map.get(name).cloned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_never_prints_the_key() {
        let options = StartOptions {
            key: Some("project-api-key_supersecret".to_string()),
            ..Default::default()
        };
        let rendered = format!("{options:?}");
        assert!(!rendered.contains("supersecret"), "{rendered}");
        assert!(rendered.contains("<redacted>"));
    }

    #[test]
    fn env_map_reads_its_pairs() {
        let env = env_map([("A", "1")]);
        assert_eq!(env("A"), Some("1".to_string()));
        assert_eq!(env("B"), None);
    }
}
