//! CLI entry point: run the 65 `contracts/` fixtures, emit the
//! compatibility report (`contracts/README.md` schema — fixtureId/suite/
//! language/status/limitation/message rows, same shape node/python/go/
//! java write).
//!
//! Usage:
//!
//! ```text
//! cargo run --bin conformance -- --contracts ../../contracts --out conformance/compatibility-report.rust.json
//! ```
//!
//! Exit code is non-zero when any fixture fails (`contracts/harness.md`
//! runner obligation 6).

mod fake_server;
mod runner;

use std::path::{Path, PathBuf};

use serde_json::Value as JsonValue;

fn repo_root() -> PathBuf {
    // sdks/rust/conformance/main.rs -> sdks/rust -> sdks -> repo root
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("repo root")
        .to_path_buf()
}

struct Args {
    contracts: PathBuf,
    out: PathBuf,
}

fn parse_args() -> Args {
    let mut contracts = repo_root().join("contracts");
    let mut out =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("conformance/compatibility-report.rust.json");
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--contracts" => {
                contracts = PathBuf::from(args.next().expect("--contracts requires a path"))
            }
            "--out" => out = PathBuf::from(args.next().expect("--out requires a path")),
            other => panic!("unknown argument {other:?}"),
        }
    }
    Args { contracts, out }
}

fn main() {
    let args = parse_args();
    let report = runner::run_all(&args.contracts);

    if let Some(parent) = args.out.parent() {
        std::fs::create_dir_all(parent).expect("create report output directory");
    }
    let pretty = serde_json::to_string_pretty(&report).expect("serialize report") + "\n";
    std::fs::write(&args.out, pretty)
        .unwrap_or_else(|e| panic!("write {}: {e}", args.out.display()));

    let results = report
        .get("results")
        .and_then(JsonValue::as_array)
        .cloned()
        .unwrap_or_default();
    let summary = report.get("summary").cloned().unwrap_or_default();
    let count = |key: &str| summary.get(key).and_then(JsonValue::as_i64).unwrap_or(0);

    println!(
        "conformance[rust]: {} passed, {} failed, {} skipped-with-documented-limitation, {} skipped-v1-out-of-scope (report: {})",
        count("pass"),
        count("fail"),
        count("skipped-with-documented-limitation"),
        count("skipped-v1-out-of-scope"),
        args.out.display(),
    );

    let mut any_fail = false;
    for row in &results {
        let status = row.get("status").and_then(JsonValue::as_str).unwrap_or("");
        let suite = row.get("suite").and_then(JsonValue::as_str).unwrap_or("");
        let fixture_id = row
            .get("fixtureId")
            .and_then(JsonValue::as_str)
            .unwrap_or("");
        if status == "fail" {
            any_fail = true;
            println!("  FAIL {suite}/{fixture_id}");
            if let Some(message) = row.get("message").and_then(JsonValue::as_str) {
                println!("       - {message}");
            }
        } else if status != "pass" {
            let limitation = row
                .get("limitation")
                .and_then(JsonValue::as_str)
                .unwrap_or("");
            println!("  SKIP {suite}/{fixture_id}: {limitation}");
        }
    }

    std::process::exit(if any_fail { 1 } else { 0 });
}
