//! Architecture guard (`spec/control-points.md` + `spec/modes.md`, "same
//! layering" as the node/python/go reference SDKs):
//!
//! - the SDK's dependency budget stays exactly `ureq` + `serde` +
//!   `serde_json` (Phase 6 controller ruling) — `Cargo.toml`'s
//!   `[dependencies]` table never grows beyond those three entries;
//! - `src/domain/` stays pure — it imports nothing from `application::` or
//!   `infrastructure::`, so the same rules/types port to every target
//!   language's validation layer without dragging adapters or runtime
//!   wiring along;
//! - `src/application/` does not reach into `infrastructure::` except
//!   through the one sanctioned seam: `mode.rs`, the composition root
//!   (its whole job is adapter selection, so its concrete
//!   `infrastructure::adapters::*` imports are expected and exempt
//!   wholesale — mirrors node's `application/mode.ts` / go's
//!   `application/mode.go` / java's `application/InitOptions.java`).
//!
//! Scans real `use` STATEMENTS only (lines starting with `use `), not
//! arbitrary substring occurrences — several doc comments in this crate
//! legitimately mention `crate::application::...` in intra-doc links
//! (e.g. `domain::validation`'s module doc), which would false-positive a
//! bare substring search.

use std::fs;
use std::path::{Path, PathBuf};

fn crate_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

fn rust_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if !dir.is_dir() {
        return out;
    }
    for entry in fs::read_dir(dir).expect("read_dir") {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            out.extend(rust_files(&path));
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
    out
}

/// Targets of every plain `use ...;` statement (not `pub use`, none of
/// which appear in `domain::`/`application::` — only `lib.rs`'s top-level
/// re-exports use `pub use`, and that file is out of scope for these
/// layering checks) in `contents`, one entry per statement. Every `use`
/// line in this crate is a single physical line (no rustfmt wraps), so a
/// per-line scan is exact, not an approximation.
///
/// Scans only the PRODUCTION portion of the file: this crate's convention
/// (every `src/domain/**`/`src/application/**` file) is an inline
/// `#[cfg(test)] mod tests { ... }` block appended at the very end, and
/// those test modules legitimately import concrete `infrastructure::`
/// adapters (`InMemoryAdapter` etc.) as test doubles — exactly what
/// node/go/java's application-layer unit tests do too, just from a
/// separate test-tree file rather than an inline module, so their
/// layering guards never see it. Truncating at the first
/// `#[cfg(test)]` marker keeps this guard scoped to the same "real
/// imports" concern the reference SDKs check, rather than penalizing
/// Rust's idiomatic inline-test convention.
fn use_statement_targets(contents: &str) -> Vec<String> {
    let production_only = contents.split("#[cfg(test)]").next().unwrap_or(contents);
    production_only
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("use "))
        .map(|line| {
            line.trim_start_matches("use ")
                .trim_end_matches(';')
                .to_string()
        })
        .collect()
}

#[test]
fn dependency_budget_is_exactly_ureq_serde_serde_json() {
    let manifest = fs::read_to_string(crate_root().join("Cargo.toml")).expect("read Cargo.toml");
    let mut in_dependencies = false;
    let mut names = Vec::new();
    for line in manifest.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_dependencies = trimmed == "[dependencies]";
            continue;
        }
        if in_dependencies && !trimmed.is_empty() && !trimmed.starts_with('#') {
            if let Some((name, _)) = trimmed.split_once('=') {
                names.push(name.trim().to_string());
            }
        }
    }
    names.sort();
    assert_eq!(
        names,
        vec!["serde".to_string(), "serde_json".to_string(), "ureq".to_string()],
        "Cargo.toml [dependencies] must be exactly ureq + serde + serde_json (Phase 6 controller ruling); \
         dev-dependencies are free but this crate needs none"
    );
}

#[test]
fn domain_imports_nothing_from_application_or_infrastructure() {
    let root = crate_root().join("src/domain");
    let files = rust_files(&root);
    assert!(!files.is_empty(), "expected source files under src/domain");

    let mut offenders = Vec::new();
    for file in files {
        let contents = fs::read_to_string(&file).expect("read domain file");
        for target in use_statement_targets(&contents) {
            if target.contains("application::") || target.contains("infrastructure::") {
                offenders.push(format!("{}: use {target}", file.display()));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "domain/ must not depend on outer layers: {offenders:?}"
    );
}

/// `mode.rs` is the SANCTIONED composition root: its defined job is adapter
/// selection, so its concrete `infrastructure::adapters::*` imports are
/// expected and exempt wholesale — skipped entirely below rather than
/// allowlisted specifier-by-specifier.
const APPLICATION_COMPOSITION_ROOT: &str = "mode.rs";

#[test]
fn application_outside_mode_rs_does_not_import_infrastructure() {
    let root = crate_root().join("src/application");
    let files = rust_files(&root);
    assert!(
        !files.is_empty(),
        "expected source files under src/application"
    );

    let mut offenders = Vec::new();
    for file in files {
        if file.file_name().and_then(|n| n.to_str()) == Some(APPLICATION_COMPOSITION_ROOT) {
            continue;
        }
        let contents = fs::read_to_string(&file).expect("read application file");
        for target in use_statement_targets(&contents) {
            if target.contains("infrastructure::") {
                offenders.push(format!("{}: use {target}", file.display()));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "application/ (outside {APPLICATION_COMPOSITION_ROOT}) must not import infrastructure/: {offenders:?}"
    );
}

/// The flip side of the guard above: confirms the exemption is actually
/// load-bearing (`mode.rs` DOES import `infrastructure::`), not a dead
/// carve-out for a boundary nothing crosses.
#[test]
fn mode_rs_is_the_only_application_file_importing_infrastructure() {
    let mode_path = crate_root()
        .join("src/application")
        .join(APPLICATION_COMPOSITION_ROOT);
    let contents = fs::read_to_string(&mode_path).expect("read mode.rs");
    let imports_infra = use_statement_targets(&contents)
        .iter()
        .any(|t| t.contains("infrastructure::"));
    assert!(imports_infra, "mode.rs is exempted as the composition root but imports no infrastructure/ module — the exemption is stale");
}
