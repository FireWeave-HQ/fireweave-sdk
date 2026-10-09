//! `instance_key()`'s derivation: a stable targeting key for reads where the
//! server itself is the subject (cron, workers, boot-time decisions).
//! Request reads still pass the user's id (node: `src/start/instance.ts`,
//! go: `fw/instance.go`).
//!
//! Sources, in order: `StartOptions.instance_id`, `FIREWEAVE_INSTANCE_ID`,
//! then `inst_` + a hash of the host name, then a random id for the life of
//! the process. Nothing is written to disk: in a container the file would
//! not outlive the process.

use std::collections::hash_map::RandomState;
use std::hash::BuildHasher;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use super::names::ENV_INSTANCE_ID;

/// Where an instance key came from.
pub(crate) const SOURCE_OPTION: &str = "option";
pub(crate) const SOURCE_ENV: &str = ENV_INSTANCE_ID;
pub(crate) const SOURCE_HOST: &str = "host";
pub(crate) const SOURCE_RANDOM: &str = "random";

/// FNV-1a 64-bit over the UTF-8 bytes, as 16 lowercase hex digits: the same
/// function node and go use, so one host name gives one instance key in
/// every SDK. Not a security hash.
pub(crate) fn fnv1a64(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// 32 hex digits, unique per call within the process and very likely across
/// processes. std has no random-number API, so this hashes the process id,
/// the wall clock and a counter with two independently keyed `RandomState`
/// hashers (std seeds those from the OS). Not a security token: it only
/// names this process when it has no host name.
pub(crate) fn random_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seed = (
        std::process::id(),
        nanos,
        COUNTER.fetch_add(1, Ordering::Relaxed),
    );
    let high = RandomState::new().hash_one(seed);
    let low = RandomState::new().hash_one(seed);
    format!("{high:016x}{low:016x}")
}

/// Pure apart from the random fallback: the lookup and the host name are
/// injected. Returns the key and its source.
pub(crate) fn derive_instance_key(
    option: Option<&str>,
    lookup: &dyn Fn(&str) -> Option<String>,
    hostname: &dyn Fn() -> Option<String>,
) -> (String, &'static str) {
    if let Some(v) = option.map(str::trim).filter(|v| !v.is_empty()) {
        return (v.to_string(), SOURCE_OPTION);
    }
    if let Some(v) = lookup(ENV_INSTANCE_ID) {
        return (v, SOURCE_ENV);
    }
    if let Some(host) = hostname()
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
    {
        return (format!("inst_{}", fnv1a64(&host)), SOURCE_HOST);
    }
    (format!("inst_{}", random_id()), SOURCE_RANDOM)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_hex(s: &str, len: usize) -> bool {
        s.len() == len
            && s.bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    }

    #[test]
    fn fnv1a64_matches_the_reference_vectors() {
        // FNV-1a 64-bit reference values; node's fnv1a64 and go's
        // hash/fnv produce the same.
        assert_eq!(fnv1a64(""), "cbf29ce484222325");
        assert_eq!(fnv1a64("a"), "af63dc4c8601ec8c");
    }

    #[test]
    fn derive_instance_key_order() {
        let host = || Some("api-pod-1".to_string());
        let no_host = || None;
        let with_id =
            |name: &str| (name == "FIREWEAVE_INSTANCE_ID").then(|| "worker-7".to_string());
        let empty = |_: &str| None;

        assert_eq!(
            derive_instance_key(Some(" cron-1 "), &with_id, &host),
            ("cron-1".to_string(), SOURCE_OPTION)
        );
        assert_eq!(
            derive_instance_key(Some("   "), &with_id, &host),
            ("worker-7".to_string(), SOURCE_ENV)
        );
        let (v, src) = derive_instance_key(None, &empty, &host);
        assert_eq!(src, SOURCE_HOST);
        // The same value node's deriveInstanceKey returns for host name
        // "api-pod-1" (sdks/node/src/start/instance.ts), so one host gives
        // one key in every SDK.
        assert_eq!(v, "inst_8148fc8bb0e952ef");
        assert!(is_hex(v.trim_start_matches("inst_"), 16));

        let (r1, src) = derive_instance_key(None, &empty, &no_host);
        let (r2, _) = derive_instance_key(None, &empty, &no_host);
        assert_eq!(src, SOURCE_RANDOM);
        assert_ne!(r1, r2);
        assert!(is_hex(r1.trim_start_matches("inst_"), 32), "{r1}");
    }
}
