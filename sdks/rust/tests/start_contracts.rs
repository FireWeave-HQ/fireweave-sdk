//! The shared start-profile suite (`contracts/start/`,
//! `spec/start-profile.md`) on Rust. Drives the start profile's pure
//! resolver and instance-key derivation (through the `#[doc(hidden)]` hooks
//! in `src/start/test_hooks.rs`), `try_define_control_points` and
//! `channel_for_version` with each case's inputs, compares by the rules in
//! `contracts/start/README.md`, and writes
//! `conformance/compatibility-report.start.rust.json` (gitignored). A port
//! of node's `test/unit/start-contracts.test.ts`.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use fireweave::start::{
    channel_for_version, derive_instance_key_for_tests, env_map, resolve_for_tests,
    try_define_control_points, Channel, LocalControlPoint, StartOptions,
};
use fireweave::{FireweaveError, Mode};
use serde_json::{json, Map, Value};

const LANG: &str = "rust";

fn crate_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

fn contracts_dir() -> PathBuf {
    crate_root().join("../../contracts/start")
}

fn report_path() -> PathBuf {
    crate_root().join("conformance/compatibility-report.start.rust.json")
}

fn load_fixtures() -> Vec<Value> {
    let dir = contracts_dir();
    let mut names: Vec<String> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("read {}: {e}", dir.display()))
        .map(|e| {
            e.expect("dir entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|n| n.ends_with(".json") && n != "start-fixture.schema.json")
        .collect();
    names.sort();
    names
        .iter()
        .map(|n| {
            let raw = fs::read_to_string(dir.join(n)).unwrap_or_else(|e| panic!("read {n}: {e}"));
            serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {n}: {e}"))
        })
        .collect()
}

/// Variable names a source may carry as-is (README "Comparing results").
const KNOWN_NAMES: [&str; 7] = [
    "FIREWEAVE_KEY",
    "FIREWEAVE_URL",
    "FIREWEAVE_ENV",
    "APP_ENV",
    "FW_PROJECT_API_KEY",
    "FW_API_URL",
    "FW_ATTEST_URL",
];

/// Variable names stay, any `StartOptions.*` field is `option`, the default
/// endpoint is `channel`, no key is `none`.
fn normalise_source(source: Option<&str>) -> Value {
    match source {
        None => Value::Null,
        Some("none") => json!("none"),
        Some(s) if s.starts_with("SDK channel") => json!("channel"),
        Some(s) if KNOWN_NAMES.contains(&s) => json!(s),
        Some(_) => json!("option"),
    }
}

struct Outcome {
    fields: Map<String, Value>,
    warnings: Vec<String>,
    error: Option<FireweaveError>,
}

impl Outcome {
    fn fields(fields: Map<String, Value>) -> Self {
        Outcome {
            fields,
            warnings: Vec::new(),
            error: None,
        }
    }

    fn error(error: FireweaveError) -> Self {
        Outcome {
            fields: Map::new(),
            warnings: Vec::new(),
            error: Some(error),
        }
    }
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

fn string_map(v: Option<&Value>) -> Vec<(String, String)> {
    v.and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn run_resolve(when: &Value) -> Result<Outcome, String> {
    let empty = json!({});
    let o = when.get("options").unwrap_or(&empty);
    let mode = match str_field(o, "mode").as_deref() {
        None => None,
        Some("local") => Some(Mode::Local),
        Some("remote") => Some(Mode::Remote),
        Some(other) => {
            return Err(format!(
                "mode {other:?} is not expressible as fireweave::Mode"
            ))
        }
    };
    let channel = match when.get("channel").and_then(Value::as_str) {
        None | Some("production") => Channel::Production,
        Some("staging") => Channel::Staging,
        Some(other) => return Err(format!("unknown channel {other:?}")),
    };
    let options = StartOptions {
        mode,
        environment: str_field(o, "environment"),
        url: str_field(o, "url"),
        key: str_field(o, "key"),
        env: Some(env_map(string_map(when.get("env")))),
        ..Default::default()
    };
    let r = match resolve_for_tests(&options, channel) {
        Ok(r) => r,
        Err(e) => return Ok(Outcome::error(e)),
    };
    let mut f = Map::new();
    f.insert("mode".into(), json!(r.mode.as_str()));
    f.insert("modeSource".into(), json!(r.mode_source));
    f.insert("url".into(), json!(r.url));
    f.insert(
        "urlSource".into(),
        normalise_source(r.url_source.as_deref()),
    );
    f.insert("allowedHosts".into(), json!(r.allowed_hosts));
    f.insert("keySource".into(), normalise_source(Some(&r.key_source)));
    f.insert("environment".into(), json!(r.environment));
    f.insert(
        "environmentSource".into(),
        normalise_source(r.environment_source.as_deref()),
    );
    Ok(Outcome {
        fields: f,
        warnings: r.warnings,
        error: None,
    })
}

fn run_instance_key(when: &Value) -> Result<Outcome, String> {
    let instance_id = when.get("options").and_then(|o| str_field(o, "instanceId"));
    let env = env_map(string_map(when.get("env")));
    let host = match when.get("hostName") {
        Some(Value::String(h)) => Some(h.as_str()),
        Some(Value::Null) => None,
        _ => return Err("instanceKey needs hostName (a string or null)".into()),
    };
    let value = derive_instance_key_for_tests(instance_id.as_deref(), Some(&env), host);
    let mut f = Map::new();
    f.insert("value".into(), json!(value));
    Ok(Outcome::fields(f))
}

/// Translates the canonical control_points object to `LocalControlPoint`s. A shape Rust's types
/// cannot express is a runner error: those cases live in
/// `start-flags-untyped`, which Rust marks not-applicable.
fn run_define_control_points(when: &Value) -> Result<Outcome, String> {
    let control_points = when
        .get("controlPoints")
        .and_then(Value::as_object)
        .ok_or("defineControlPoints needs a controlPoints object")?;
    let mut entries = Vec::new();
    for (key, spec) in control_points {
        let spec = spec
            .as_object()
            .ok_or(format!("flag {key:?} is not an object"))?;
        if spec.keys().any(|k| k != "local" && k != "description") {
            return Err(format!("flag {key:?} has fields Rust cannot express"));
        }
        let local = spec
            .get("local")
            .and_then(Value::as_bool)
            .ok_or(format!("flag {key:?} has no boolean local"))?;
        let mut flag = LocalControlPoint::local(local);
        match spec.get("description") {
            None => {}
            Some(Value::String(d)) => flag = flag.describe(d.clone()),
            Some(_) => return Err(format!("flag {key:?} has a non-string description")),
        }
        entries.push((key.clone(), flag));
    }
    Ok(match try_define_control_points(entries) {
        Ok(_) => {
            let mut f = Map::new();
            f.insert("ok".into(), json!(true));
            Outcome::fields(f)
        }
        Err(e) => Outcome::error(e),
    })
}

fn run_channel_for_version(when: &Value) -> Result<Outcome, String> {
    let version = when
        .get("version")
        .and_then(Value::as_str)
        .ok_or("channelForVersion needs a version")?;
    let mut f = Map::new();
    f.insert(
        "channel".into(),
        json!(channel_for_version(version).as_str()),
    );
    Ok(Outcome::fields(f))
}

fn run(when: &Value) -> Result<Outcome, String> {
    match when.get("operation").and_then(Value::as_str) {
        Some("resolve") => run_resolve(when),
        Some("instanceKey") => run_instance_key(when),
        Some("defineControlPoints") => run_define_control_points(when),
        Some("channelForVersion") => run_channel_for_version(when),
        other => Err(format!("operation {other:?} is not applicable to {LANG}")),
    }
}

fn names(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// The differences; empty when the case passes.
fn compare(expect: &Map<String, Value>, out: &Outcome) -> Vec<String> {
    let mut diffs = Vec::new();
    if let Some(want) = expect.get("error") {
        let kind = want.get("kind").and_then(Value::as_str).unwrap_or_default();
        let Some(err) = &out.error else {
            return vec![format!(
                "expected a {kind} error, got {}",
                Value::Object(out.fields.clone())
            )];
        };
        let got_kind = err.kind.as_str();
        if got_kind != kind {
            diffs.push(format!("error kind {got_kind}, expected {kind}"));
        }
        for n in names(want.get("mentions")) {
            if !err.message.contains(&n) {
                diffs.push(format!("error does not mention {n}: {}", err.message));
            }
        }
        for n in names(want.get("mustNotMention")) {
            if err.message.contains(&n) {
                diffs.push(format!("error mentions {n}"));
            }
        }
        return diffs;
    }
    if let Some(err) = &out.error {
        return vec![format!(
            "unexpected {} error: {}",
            err.kind.as_str(),
            err.message
        )];
    }
    for (field, want) in expect {
        match field.as_str() {
            "warnings" => {
                for n in names(want.get("mention")) {
                    if !out.warnings.iter().any(|l| l.contains(&n)) {
                        diffs.push(format!("no warning mentions {n}"));
                    }
                }
                for n in names(want.get("mustNotMention")) {
                    if out.warnings.iter().any(|l| l.contains(&n)) {
                        diffs.push(format!("a warning mentions {n}"));
                    }
                }
            }
            "prefix" => {
                let v = out
                    .fields
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let p = want.as_str().unwrap_or_default();
                if !v.starts_with(p) {
                    diffs.push(format!("value {v} does not start with {p}"));
                }
            }
            _ => {
                let got = out.fields.get(field).cloned().unwrap_or(Value::Null);
                if field == "allowedHosts" {
                    if let (Value::Array(w), Value::Array(g)) = (want, &got) {
                        let w: BTreeSet<String> = w.iter().map(Value::to_string).collect();
                        let g: BTreeSet<String> = g.iter().map(Value::to_string).collect();
                        if w != g {
                            diffs.push(format!("allowedHosts {got}, expected {want}"));
                        }
                        continue;
                    }
                }
                if &got != want {
                    diffs.push(format!("{field} {got}, expected {want}"));
                }
            }
        }
    }
    diffs
}

struct FixtureResult {
    id: String,
    declared: String,
    status: &'static str,
    message: String,
    report: Value,
}

fn run_fixture(fx: &Value) -> FixtureResult {
    let id = str_field(fx, "id").expect("fixture id");
    let declared = fx
        .get("compatibility")
        .and_then(|c| str_field(c, LANG))
        .expect("compatibility cell");
    if declared == "not-applicable" {
        return FixtureResult {
            report: json!({ "fixtureId": id, "status": "not-applicable", "cases": [], "message": "" }),
            id,
            declared,
            status: "not-applicable",
            message: String::new(),
        };
    }
    let mut cases = Vec::new();
    let mut failed = Vec::new();
    for c in fx.get("cases").and_then(Value::as_array).expect("cases") {
        let name = str_field(c, "name").expect("case name");
        let applies = c
            .get("appliesTo")
            .and_then(Value::as_array)
            .is_none_or(|a| a.iter().any(|l| l.as_str() == Some(LANG)));
        if !applies {
            cases.push(json!({ "name": name, "status": "not-applicable" }));
            continue;
        }
        let expect = c.get("expect").and_then(Value::as_object).expect("expect");
        let diffs = match run(c.get("when").expect("when")) {
            Ok(out) => compare(expect, &out),
            Err(e) => vec![format!("runner: {e}")],
        };
        if diffs.is_empty() {
            cases.push(json!({ "name": name, "status": "pass" }));
        } else {
            let msg = diffs.join("; ");
            failed.push(format!("{name}: {msg}"));
            cases.push(json!({ "name": name, "status": "fail", "message": msg }));
        }
    }
    let status = if failed.is_empty() { "pass" } else { "fail" };
    let message = failed.join(" | ");
    FixtureResult {
        report: json!({ "fixtureId": id, "status": status, "cases": cases, "message": message }),
        id,
        declared,
        status,
        message,
    }
}

/// Runs the whole suite once per test binary and writes the report.
fn results() -> &'static BTreeMap<String, FixtureResult> {
    static RESULTS: OnceLock<BTreeMap<String, FixtureResult>> = OnceLock::new();
    RESULTS.get_or_init(|| {
        let fixtures = load_fixtures();
        assert!(
            fixtures.len() >= 10,
            "expected the shared start-profile suite in {}",
            contracts_dir().display()
        );
        let results: Vec<FixtureResult> = fixtures.iter().map(run_fixture).collect();
        let report = json!({
            "language": LANG,
            "suite": "start",
            "results": results.iter().map(|r| r.report.clone()).collect::<Vec<_>>(),
        });
        let text = serde_json::to_string_pretty(&report).expect("render report") + "\n";
        fs::write(report_path(), text)
            .unwrap_or_else(|e| panic!("write {}: {e}", report_path().display()));
        results.into_iter().map(|r| (r.id.clone(), r)).collect()
    })
}

fn assert_fixture(id: &str) {
    let r = results()
        .get(id)
        .unwrap_or_else(|| panic!("fixture {id} is missing from contracts/start"));
    assert_eq!(r.declared, "pass", "{id} is not declared pass for {LANG}");
    assert_eq!(r.status, "pass", "{id}: {}", r.message);
}

/// One test per fixture declared `pass` for Rust; the list is checked
/// against the fixtures below, so a new fixture cannot go unrun.
macro_rules! fixture_tests {
    ($($test:ident => $id:literal),* $(,)?) => {
        const FIXTURE_TESTS: &[&str] = &[$($id),*];
        $(
            #[test]
            fn $test() {
                assert_fixture($id);
            }
        )*
    };
}

fixture_tests! {
    start_channel_rule => "start-channel-rule",
    start_config_precedence => "start-config-precedence",
    start_endpoint => "start-endpoint",
    start_flags => "start-flags",
    start_instance_key => "start-instance-key",
    start_key_families_server => "start-key-families-server",
    start_legacy_names => "start-legacy-names",
    start_mode_rule => "start-mode-rule",
}

#[test]
fn every_fixture_declared_pass_has_a_test() {
    let declared: BTreeSet<&str> = results()
        .values()
        .filter(|r| r.declared == "pass")
        .map(|r| r.id.as_str())
        .collect();
    let tested: BTreeSet<&str> = FIXTURE_TESTS.iter().copied().collect();
    assert_eq!(
        declared, tested,
        "add a fixture_tests! entry for every fixture declared pass for {LANG}"
    );
}
