//! The ONLY file in this crate that reads the process environment or the
//! host name.
//!
//! The core SDK reads no environment variables (`spec/modes.md`). The start
//! profile is the documented exception (`docs/adr/0012-start-profile.md`),
//! and `tests/start_guards.rs` pins every environment read and every
//! host-name read to this file.

use std::sync::Arc;

/// Reads one variable for the start profile: trimmed, and `None` when the
/// variable is unset, empty or only whitespace (the three are the same to
/// the start profile).
pub(crate) type Lookup = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Trims a value and maps empty to `None`.
pub(crate) fn trimmed(value: Option<String>) -> Option<String> {
    let value = value?;
    let t = value.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// The running process's environment. A value that is not valid UTF-8 still
/// counts as set (lossily converted), so a mangled key fails at fw-server
/// rather than silently selecting local mode.
fn process_env(name: &str) -> Option<String> {
    trimmed(std::env::var_os(name).map(|v| v.to_string_lossy().into_owned()))
}

/// `StartOptions.env` when set (tests, `run(getenv)`-style apps), else the
/// process environment. Values are trimmed either way.
pub(crate) fn lookup_from(custom: Option<&super::EnvFn>) -> Lookup {
    match custom {
        Some(get) => {
            let get = Arc::clone(get);
            Arc::new(move |name: &str| trimmed(get(name)))
        }
        None => Arc::new(process_env),
    }
}

/// The host name, or `None` when std cannot find one. Rust's standard
/// library has no `gethostname`, and this crate adds no dependency for one,
/// so the sources are, in order:
///
/// 1. `/proc/sys/kernel/hostname` (Linux, containers): the kernel host name,
///    the same value Go's `os.Hostname` and Node's `os.hostname()` return;
/// 2. `HOSTNAME` (exported by most container runtimes; Node reads it first);
/// 3. `COMPUTERNAME` (Windows);
/// 4. `/etc/hostname`.
///
/// macOS exposes none of these to a plain process unless the shell exports
/// `HOSTNAME`; there `instance_key()` falls back to a random per-process key
/// (with one warning) unless `FIREWEAVE_INSTANCE_ID` is set.
pub(crate) fn process_hostname() -> Option<String> {
    read_trimmed_file("/proc/sys/kernel/hostname")
        .or_else(|| process_env("HOSTNAME"))
        .or_else(|| process_env("COMPUTERNAME"))
        .or_else(|| read_trimmed_file("/etc/hostname"))
}

fn read_trimmed_file(path: &str) -> Option<String> {
    trimmed(std::fs::read_to_string(path).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trimmed_maps_blank_to_none() {
        assert_eq!(trimmed(None), None);
        assert_eq!(trimmed(Some(String::new())), None);
        assert_eq!(trimmed(Some("  \t ".to_string())), None);
        assert_eq!(
            trimmed(Some("  dev \n".to_string())),
            Some("dev".to_string())
        );
    }

    #[test]
    fn a_custom_lookup_is_trimmed_too() {
        let custom: crate::start::EnvFn = Arc::new(|name: &str| match name {
            "A" => Some("  value ".to_string()),
            "B" => Some("   ".to_string()),
            _ => None,
        });
        let lookup = lookup_from(Some(&custom));
        assert_eq!(lookup("A"), Some("value".to_string()));
        assert_eq!(lookup("B"), None);
        assert_eq!(lookup("C"), None);
    }
}
