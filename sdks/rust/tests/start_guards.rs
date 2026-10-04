//! Start-profile guards (`docs/adr/0012-start-profile.md`, "the portability
//! guard changes shape, not strength"), the Rust counterpart of go's
//! `fireweave/architecture_guard_test.go` start-profile section:
//!
//! - `src/start/` is built only on the crate's PUBLIC API (the names
//!   `src/lib.rs` re-exports at the crate root) and the standard library:
//!   no `crate::application`/`domain`/`infrastructure` paths, no escaping
//!   `super::super`, no direct `serde`/`serde_json`/`ureq`;
//! - no core module (everything under `src/` outside `src/start/`)
//!   references the start module, so the core never depends on the profile
//!   layered over it;
//! - the process environment and the host name are read only in the seam
//!   file `src/start/env.rs` (the core reads none, `spec/modes.md`).
//!
//! Sources are scanned with comments stripped (so doc comments may name
//! anything) but string literals kept (so a `"HOSTNAME"` lookup counts), and
//! with all whitespace removed, so `std :: env` and multi-line `use` groups
//! cannot slip past. Inline `#[cfg(test)]` modules are scanned too: a test
//! inside the core reading the environment is still the core reading it.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

const START_DIR: &str = "src/start";
const ENV_SEAM: &str = "src/start/env.rs";

fn crate_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

fn rust_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in fs::read_dir(dir).expect("read_dir") {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            out.extend(rust_files(&path));
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
    out.sort();
    out
}

/// One scanned source file: its path relative to the crate root, its code
/// with comments stripped and whitespace removed (`text`, string literals
/// kept), and the same with string and char literal contents blanked
/// (`code`, for path checks, so a message that names a path is not a use).
struct Source {
    rel: String,
    text: String,
    code: String,
}

fn sources() -> Vec<Source> {
    let root = crate_root();
    rust_files(&root.join("src"))
        .into_iter()
        .map(|p| {
            let rel = p
                .strip_prefix(&root)
                .expect("under the crate root")
                .to_string_lossy()
                .replace('\\', "/");
            let raw = fs::read_to_string(&p).expect("read source");
            Source {
                rel,
                text: squash(&strip(&raw, true)),
                code: squash(&strip(&raw, false)),
            }
        })
        .collect()
}

fn in_start(rel: &str) -> bool {
    rel.starts_with(&format!("{START_DIR}/"))
}

/// Removes `//` and (nested) `/* */` comments. String and char literals
/// (raw strings and `'"'` included) are kept intact when `keep_strings`,
/// else replaced by an empty `""`.
fn strip(src: &str, keep_strings: bool) -> String {
    let c: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    let ident = |ch: char| ch.is_alphanumeric() || ch == '_';
    while i < c.len() {
        let next = c.get(i + 1).copied();
        if c[i] == '/' && next == Some('/') {
            while i < c.len() && c[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c[i] == '/' && next == Some('*') {
            let mut depth = 0;
            while i < c.len() {
                if c[i] == '/' && c.get(i + 1) == Some(&'*') {
                    depth += 1;
                    i += 2;
                } else if c[i] == '*' && c.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            out.push(' ');
            continue;
        }
        // Raw string: r"..." / r#"..."# (optionally b-prefixed), not inside
        // an identifier.
        if c[i] == 'r'
            && (i == 0 || !ident(c[i - 1]) || (c[i - 1] == 'b' && (i < 2 || !ident(c[i - 2]))))
        {
            let mut j = i + 1;
            while j < c.len() && c[j] == '#' {
                j += 1;
            }
            if j < c.len() && c[j] == '"' {
                let hashes = j - i - 1;
                let mut k = j + 1;
                loop {
                    if k >= c.len() {
                        break;
                    }
                    if c[k] == '"' && (0..hashes).all(|h| c.get(k + 1 + h) == Some(&'#')) {
                        k += 1 + hashes;
                        break;
                    }
                    k += 1;
                }
                literal(&mut out, &c[i..k.min(c.len())], keep_strings);
                i = k;
                continue;
            }
        }
        if c[i] == '"' {
            let start = i;
            i += 1;
            while i < c.len() && c[i] != '"' {
                if c[i] == '\\' {
                    i += 1;
                }
                i += 1;
            }
            i = (i + 1).min(c.len());
            literal(&mut out, &c[start..i], keep_strings);
            continue;
        }
        if c[i] == '\'' {
            // Char literal ('x', '\n', '"') vs lifetime ('a).
            if next == Some('\\') {
                let start = i;
                i += 2;
                while i < c.len() && c[i] != '\'' {
                    i += 1;
                }
                i = (i + 1).min(c.len());
                literal(&mut out, &c[start..i], keep_strings);
                continue;
            }
            if c.get(i + 2) == Some(&'\'') {
                literal(&mut out, &c[i..i + 3], keep_strings);
                i += 3;
                continue;
            }
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

fn literal(out: &mut String, lit: &[char], keep: bool) {
    if keep {
        out.extend(lit);
    } else {
        out.push_str("\"\"");
    }
}

/// Collapses whitespace runs to one space and drops the space next to
/// punctuation, so `std :: env`, `use std::{ a,\n b }` and `pub mod start ;`
/// each have one spelling, while `use crate::x` keeps its word boundary.
fn squash(code: &str) -> String {
    let mut collapsed = String::with_capacity(code.len());
    for ch in code.chars() {
        if ch.is_whitespace() {
            if !collapsed.ends_with(' ') {
                collapsed.push(' ');
            }
        } else {
            collapsed.push(ch);
        }
    }
    let punct = |c: Option<char>| {
        c.is_some_and(|c| !(c.is_alphanumeric() || c == '_' || c == '"' || c == '\''))
    };
    let chars: Vec<char> = collapsed.chars().collect();
    let mut out = String::with_capacity(chars.len());
    for (i, ch) in chars.iter().enumerate() {
        if *ch == ' ' {
            let prev = if i == 0 { None } else { Some(chars[i - 1]) };
            let next = chars.get(i + 1).copied();
            if prev.is_none() || next.is_none() || punct(prev) || punct(next) {
                continue;
            }
        }
        out.push(*ch);
    }
    out
}

/// Splits a `{...}` group body (without the braces) at top-level commas.
fn group_items(body: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut depth = 0;
    let mut current = String::new();
    for ch in body.chars() {
        match ch {
            '{' => {
                depth += 1;
                current.push(ch);
            }
            '}' => {
                depth -= 1;
                current.push(ch);
            }
            ',' if depth == 0 => {
                items.push(std::mem::take(&mut current));
            }
            _ => current.push(ch),
        }
    }
    items.push(current);
    items.into_iter().filter(|s| !s.is_empty()).collect()
}

/// The group body following `{` at `start` (exclusive of the braces).
fn group_at(s: &str, open: usize) -> &str {
    let mut depth = 0;
    for (i, ch) in s[open..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return &s[open + 1..open + i];
                }
            }
            _ => {}
        }
    }
    &s[open + 1..]
}

/// The first segment of every path that follows `prefix` (e.g. `crate::`)
/// in squashed code, expanding `prefix{a, b::c}` groups. Only matches where
/// `prefix` starts a path (not preceded by an identifier character or `::`).
fn path_roots(squashed: &str, prefix: &str) -> Vec<String> {
    segment_followers(squashed, prefix, false)
}

/// Like [`path_roots`], but `prefix` may also sit mid-path, so a chain such
/// as `super::super::start` yields `super` and then `start`.
fn segment_followers(squashed: &str, prefix: &str, mid_path: bool) -> Vec<String> {
    let mut roots = Vec::new();
    let mut from = 0;
    while let Some(pos) = squashed[from..].find(prefix) {
        let at = from + pos;
        from = at + prefix.len();
        let before = squashed[..at].chars().last();
        if before.is_some_and(|b| b.is_alphanumeric() || b == '_' || (b == ':' && !mid_path)) {
            continue;
        }
        let rest = &squashed[at + prefix.len()..];
        if rest.starts_with('{') {
            for item in group_items(group_at(rest, 0)) {
                roots.push(first_segment(&item));
            }
        } else {
            roots.push(first_segment(rest));
        }
    }
    roots
}

fn first_segment(path: &str) -> String {
    path.chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '*')
        .collect()
}

/// Names the crate root makes public: `pub use` re-exports (or their `as`
/// aliases) and `pub const`s. The root's `pub mod`s are deliberately NOT
/// included: `crate::application::...` is reachable but is not the
/// sanctioned public surface.
fn root_public_names() -> BTreeSet<String> {
    let lib = squash(&strip(
        &fs::read_to_string(crate_root().join("src/lib.rs")).expect("read lib.rs"),
        false,
    ));
    let mut names = BTreeSet::new();
    for stmt in lib.split(';') {
        if let Some(path) = stmt.split("pub use ").nth(1) {
            let last = match path.rfind("::") {
                Some(i) => &path[i + 2..],
                None => path,
            };
            let items = if last.starts_with('{') {
                group_items(group_at(last, 0))
            } else {
                vec![last.to_string()]
            };
            for item in items {
                let name = item.rsplit(" as ").next().unwrap_or(&item).to_string();
                names.insert(first_segment(&name));
            }
        }
        if let Some(rest) = stmt.split("pub const ").nth(1) {
            names.insert(first_segment(rest));
        }
    }
    names
}

#[test]
fn the_start_module_uses_only_the_crate_root_public_api_and_std() {
    let public = root_public_names();
    for expected in [
        "FireweaveClient",
        "init_fireweave",
        "BackendAdapter",
        "VERSION",
    ] {
        assert!(
            public.contains(expected),
            "root public-name parser is broken: {expected} missing from {public:?}"
        );
    }
    for internal in ["application", "domain", "infrastructure"] {
        assert!(
            !public.contains(internal),
            "{internal} must not count as public API"
        );
    }

    let mut offenders = Vec::new();
    let mut start_files = 0;
    for src in sources() {
        if !in_start(&src.rel) {
            continue;
        }
        start_files += 1;
        let (rel, s) = (&src.rel, &src.code);
        for root in path_roots(s, "crate::") {
            if root != "start" && !public.contains(&root) {
                offenders.push(format!(
                    "{rel}: crate::{root} is not a crate-root re-export"
                ));
            }
        }
        for banned in ["super::super", "self::super"] {
            if s.contains(banned) {
                offenders.push(format!(
                    "{rel}: `{banned}` reaches outside the start module's public-API layer"
                ));
            }
        }
        // The crate's own dependencies, used directly instead of through
        // its public API (any other crate would not compile at all).
        for dep in ["fireweave::", "serde_json::", "serde::", "ureq::"] {
            if !path_roots(s, dep).is_empty() {
                offenders.push(format!(
                    "{rel}: uses `{dep}` directly (only the crate root's public API and std)"
                ));
            }
        }
    }
    assert!(
        start_files >= 5,
        "expected the start profile under {START_DIR}"
    );
    assert!(
        offenders.is_empty(),
        "src/start/ may use only the crate root's public re-exports and std (ADR-0012):\n{}",
        offenders.join("\n")
    );
}

#[test]
fn no_core_module_references_the_start_module() {
    let mut offenders = Vec::new();
    for src in sources() {
        if in_start(&src.rel) {
            continue;
        }
        let (rel, s) = (&src.rel, &src.code);
        for prefix in ["crate::", "super::", "self::", "fireweave::"] {
            if segment_followers(s, prefix, true)
                .iter()
                .any(|r| r == "start")
            {
                offenders.push(format!("{rel}: {prefix}start"));
            }
        }
        // `pub mod start;` in lib.rs is the one sanctioned mention.
        let declares = s.matches("mod start;").count();
        let sanctioned = rel == "src/lib.rs" && s.matches("pub mod start;").count() == 1;
        if declares > usize::from(sanctioned) {
            offenders.push(format!("{rel}: declares the start module"));
        }
    }
    assert!(
        offenders.is_empty(),
        "the core must not depend on the start profile layered over it: {offenders:?}"
    );
}

/// Shapes that read the process environment or the host name. `text`
/// keeps string literals (a `"HOSTNAME"` lookup counts); `code` has them
/// blanked (for `use std::{env, ..}` groups).
fn env_or_host_reads(text: &str, code: &str) -> Vec<String> {
    let mut found = Vec::new();
    for needle in [
        "std::env",
        "env::var",
        "env::vars",
        "std::fs",
        "fs::read",
        "fs::File",
        "process::Command",
        "\"HOSTNAME\"",
        "\"COMPUTERNAME\"",
        "/etc/hostname",
        "/proc/sys/kernel/hostname",
        "gethostname",
    ] {
        if text.contains(needle) {
            found.push(needle.to_string());
        }
    }
    // `use std::{env, fs, ...}` groups (and `::std::{...}`).
    for item in path_roots(code, "std::") {
        if item == "env" || item == "fs" {
            found.push(format!("std::{{{item}}}"));
        }
    }
    found.sort();
    found.dedup();
    found
}

#[test]
fn only_the_env_seam_reads_the_environment_or_the_host_name() {
    let mut offenders = Vec::new();
    let mut seam = None;
    for src in sources() {
        if src.rel == ENV_SEAM {
            seam = Some(src.text);
            continue;
        }
        for read in env_or_host_reads(&src.text, &src.code) {
            offenders.push(format!("{}: {read}", src.rel));
        }
    }
    assert!(
        offenders.is_empty(),
        "only {ENV_SEAM} may read the environment or the host name (the core reads none, spec/modes.md; the start profile reads through one seam, ADR-0012):\n{}",
        offenders.join("\n")
    );

    // The seam really is the seam: if it stops reading, the guard is stale.
    let seam =
        seam.unwrap_or_else(|| panic!("{ENV_SEAM} must exist: it is the start profile's env seam"));
    for want in [
        "std::env::var_os",
        "\"HOSTNAME\"",
        "/proc/sys/kernel/hostname",
    ] {
        assert!(
            seam.contains(want),
            "{ENV_SEAM} no longer contains {want}; update the guard with the seam"
        );
    }
}

/// The scanners themselves: each shape a violation could take is caught,
/// and comments are not.
#[test]
fn the_scanners_catch_every_shape() {
    let cases = [
        "fn f() { let _ = std::env::var(\"X\"); }",
        "use std::env; fn f() { env::var_os(\"X\"); }",
        "use std::env as e; fn f() { e::var(\"X\"); }",
        "use std::{collections::HashMap, env}; fn f() { env::vars(); }",
        "use std :: env :: var; fn f() { var(\"X\"); }",
        "fn f() { ::std::env::vars_os(); }",
        "fn f() { std::fs::read_to_string(\"/etc/hostname\"); }",
        "use std::{fs, io}; fn f() { fs::read(\"x\"); }",
        "fn f() { lookup(\"HOSTNAME\"); }",
    ];
    let reads =
        |case: &str| env_or_host_reads(&squash(&strip(case, true)), &squash(&strip(case, false)));
    for case in cases {
        assert!(!reads(case).is_empty(), "missed: {case}");
    }
    let clean = [
        "/// reads std::env::var in the docs only\nfn f() {}",
        "/* std::env::var */ fn f() { let v = env!(\"CARGO_PKG_VERSION\"); }",
        "fn f() { let s = \"https://example.com\"; // std::env::var\n }",
        "fn f() { let c = '\"'; let s = \"no env here\"; } // std::fs",
        "fn f<'a>(x: &'a str) -> &'a str { x } // std::env::var",
    ];
    for case in clean {
        assert!(reads(case).is_empty(), "false positive: {case}");
    }

    // Path roots expand groups and ignore paths named inside strings.
    let s = squash(&strip(
        "use crate::{FireweaveClient, application::runtime::RuntimeConfig};\nuse crate::domain::errors::ErrorKind;\nlet m = \"see crate::infrastructure\";",
        false,
    ));
    assert_eq!(
        path_roots(&s, "crate::"),
        vec!["FireweaveClient", "application", "domain"]
    );
    let s = squash(&strip("use super::super::{start::status, domain};", false));
    assert_eq!(
        segment_followers(&s, "super::", true),
        vec!["super", "start", "domain"]
    );
}
