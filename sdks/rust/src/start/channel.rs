//! The release channel of this crate build. It chooses the default fw-server
//! endpoint (`docs/adr/0012-start-profile.md`, rule 3).
//!
//! No stamp file is needed: Cargo compiles `CARGO_PKG_VERSION` into the
//! consumer's build of this crate, so it is the version the app resolved
//! from crates.io (or a path/git dependency's manifest).
//! `tools/release/version.sh` spells a Rust staging release
//! `X.Y.Z-rc.N` in `Cargo.toml`.

use super::names::{PRODUCTION_URL, STAGING_URL};

/// Release channel of an SDK build.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Channel {
    Production,
    Staging,
}

impl Channel {
    pub fn as_str(&self) -> &'static str {
        match self {
            Channel::Production => "production",
            Channel::Staging => "staging",
        }
    }

    /// The fw-server endpoint this channel defaults to.
    pub fn default_url(&self) -> &'static str {
        match self {
            Channel::Production => PRODUCTION_URL,
            Channel::Staging => STAGING_URL,
        }
    }
}

impl std::fmt::Display for Channel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The channel rule, as a pure function of a crate version: a version
/// containing `-rc.` is [`Channel::Staging`]; anything else is
/// [`Channel::Production`], including `-staging.N`, which stopped being a
/// staging spelling at 3.0.0.
///
/// ```
/// use fireweave::start::{channel_for_version, Channel};
/// assert_eq!(channel_for_version("2.4.0-rc.3"), Channel::Staging);
/// assert_eq!(channel_for_version("2.4.0"), Channel::Production);
/// ```
pub fn channel_for_version(version: &str) -> Channel {
    if version.contains("-rc.") {
        Channel::Staging
    } else {
        Channel::Production
    }
}

/// This crate's version, as compiled into the app (`Cargo.toml`'s
/// `[package].version`, e.g. `2.4.0` or `2.4.0-rc.1`).
pub fn sdk_version() -> &'static str {
    crate::VERSION
}

/// The release channel of this crate build.
pub fn sdk_channel() -> Channel {
    channel_for_version(sdk_version())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rc_versions_select_staging() {
        assert_eq!(channel_for_version("2.4.0-rc.1"), Channel::Staging);
        assert_eq!(channel_for_version("10.0.12-rc.37"), Channel::Staging);
    }

    #[test]
    fn everything_else_is_production() {
        // -staging.N stopped being a staging spelling at 3.0.0.
        for v in [
            "2.4.0",
            "2.4.0-rc",
            "2.4.0-staging.1",
            "10.0.12-staging.37",
            "2.4.0-staging",
            "",
            "staging",
        ] {
            assert_eq!(channel_for_version(v), Channel::Production, "{v}");
        }
    }

    #[test]
    fn channels_map_to_their_hosts() {
        assert_eq!(
            Channel::Production.default_url(),
            "https://app-server.fireweave.ai"
        );
        assert_eq!(
            Channel::Staging.default_url(),
            "https://staging-app-server.fireweave.ai"
        );
    }
}
