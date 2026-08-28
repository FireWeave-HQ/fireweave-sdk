//! Control-point SURFACE parity (`spec/control-points.md`,
//! `conformance/surface/`).
//!
//! Behaviour is asserted elsewhere (`src/**/tests` inline modules); this
//! file asserts the surface EXISTS. That distinction matters because a
//! missing method is invisible: go shipped `client.Flags()` with no
//! `ControlPoints` namespace, and python shipped `get_integer_value` with
//! no object variant, both unnoticed for months, because nothing
//! structurally forced seven independent implementations to agree. A
//! parity fixture turns silent divergence into a failing assertion.
//!
//! **Spec-ambiguity note (recorded in task-12-report.md as a numbered
//! finding):** node/python/go/java assert "arity per args" and
//! "mustNotExpose" via runtime reflection (`inspect.signature`,
//! `reflect.TypeOf(...).MethodByName`) — Rust has no runtime reflection
//! API at all, so neither technique has a direct translation. This file
//! resolves both:
//!
//! - **Arity**: Rust's compiler already enforces exact arity at every call
//!   site — a wrong parameter count is a compile ERROR, not a runtime
//!   failure. `nine_methods_are_callable_at_the_pinned_arity` calls every
//!   one of the nine methods at exactly the descriptor's declared arity;
//!   if a signature ever drifts, the whole test **binary fails to build**,
//!   a strictly stronger guarantee than the reference SDKs' runtime
//!   assertion. `nine_methods_match_descriptor_arity` separately keeps the
//!   descriptor's own declared counts honest against a hardcoded
//!   expectation, so a descriptor change is caught even before that
//!   recompile.
//! - **mustNotExpose**: implemented as a source scan (the same technique
//!   `tests/architecture_guard.rs` uses for module-dependency-direction),
//!   matching Rust ITEM-DEFINITION shapes (`fn releases(`, `struct
//!   FireweaveProvider`, ...) rather than bare substrings — several doc
//!   comments in this crate legitimately use these words in prose (e.g.
//!   "releases, exposures, signals, capabilities discovery ... are out of
//!   scope"), which a naive substring scan would false-positive on.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use fireweave::{
    Decision, EvaluateOptions, EvaluationContext, FireweaveClient, FireweaveRuntime, FlagType,
    InMemoryAdapter, JsonValue, RuntimeConfig,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct SurfaceMethod {
    name: String,
    args: Vec<String>,
    #[serde(rename = "localMode")]
    local_mode: Option<String>,
}

#[derive(Deserialize)]
struct Namespace {
    casing: BTreeMap<String, String>,
    #[serde(rename = "deprecatedAlias")]
    deprecated_alias: String,
    #[serde(rename = "aliasMustShareIdentity")]
    alias_must_share_identity: bool,
}

#[derive(Deserialize)]
struct ClientSection {
    methods: Vec<SurfaceMethod>,
    #[serde(rename = "mustNotExpose")]
    must_not_expose: Vec<String>,
}

#[derive(Deserialize)]
struct SurfaceDescriptor {
    namespace: Namespace,
    methods: Vec<SurfaceMethod>,
    client: ClientSection,
    compatibility: BTreeMap<String, String>,
}

fn load_descriptor() -> SurfaceDescriptor {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance/surface/control-points.surface.json");
    let contents =
        fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&contents).expect("parse surface descriptor")
}

fn client() -> FireweaveClient {
    let runtime = Arc::new(FireweaveRuntime::new(
        Box::new(InMemoryAdapter::new(Default::default())),
        RuntimeConfig::default(),
    ));
    FireweaveClient::new(runtime)
}

#[test]
fn namespace_casing_is_control_points_per_descriptor() {
    let d = load_descriptor();
    assert_eq!(
        d.namespace.casing.get("rust").map(String::as_str),
        Some("control_points")
    );
    // The namespace exists under that exact accessor name.
    let _: &fireweave::ControlPointsNamespace = &client().control_points;
}

#[test]
fn nine_methods_match_descriptor_arity() {
    let d = load_descriptor();
    assert_eq!(
        d.methods.len(),
        9,
        "expected exactly nine methods in the surface descriptor"
    );

    let expected_arities: BTreeMap<&str, usize> = [
        ("getBooleanValue", 3),
        ("getStringValue", 3),
        ("getNumberValue", 3),
        ("getObjectValue", 3),
        ("getBooleanDetails", 3),
        ("getStringDetails", 3),
        ("getNumberDetails", 3),
        ("getObjectDetails", 3),
        ("evaluate", 5),
    ]
    .into_iter()
    .collect();

    let mut offenders = Vec::new();
    for m in &d.methods {
        match expected_arities.get(m.name.as_str()) {
            None => offenders.push(format!(
                "{}: not one of the recognized nine method names",
                m.name
            )),
            Some(&expected) if m.args.len() != expected => offenders.push(format!(
                "{}: descriptor declares {} args, hardcoded expectation is {expected}",
                m.name,
                m.args.len()
            )),
            _ => {}
        }
    }
    assert!(offenders.is_empty(), "arity mismatches: {offenders:?}");
}

/// See the module doc comment: this is the compile-time half of the arity
/// proof. If any of these calls has the wrong number of arguments for its
/// method's real signature, this file — and therefore `cargo test` itself
/// — fails to build.
#[test]
fn nine_methods_are_callable_at_the_pinned_arity() {
    let fw = client();
    fw.initialize().unwrap();
    let cp = &fw.control_points;
    let ctx = EvaluationContext::new().with_targeting_key("t");

    let _: bool = cp.get_boolean_value("k", false, Some(&ctx));
    let _: String = cp.get_string_value("k", "d", Some(&ctx));
    let _: f64 = cp.get_number_value("k", 0.0, Some(&ctx));
    let _: JsonValue = cp.get_object_value("k", JsonValue::Null, Some(&ctx));
    let _: Decision = cp.get_boolean_details("k", false, Some(&ctx));
    let _: Decision = cp.get_string_details("k", "d", Some(&ctx));
    let _: Decision = cp.get_number_details("k", 0.0, Some(&ctx));
    let _: Decision = cp.get_object_details("k", JsonValue::Null, Some(&ctx));
    let opts = EvaluateOptions::default();
    let _: Decision = cp.evaluate(
        "k",
        FlagType::Boolean,
        JsonValue::Bool(false),
        Some(&ctx),
        Some(&opts),
    );
}

#[test]
fn details_returns_a_decision_value_returns_the_bare_value() {
    let fw = client();
    fw.initialize().unwrap();
    let value = fw.control_points.get_boolean_value("absent", false, None);
    let details = fw.control_points.get_boolean_details("absent", false, None);
    assert!(!value);
    assert!(!details.value.as_bool().unwrap());
    assert!(!details.reason.is_empty());
}

#[test]
fn the_deprecated_flags_alias_shares_identity_with_control_points() {
    let d = load_descriptor();
    assert_eq!(d.namespace.deprecated_alias, "flags");
    assert!(d.namespace.alias_must_share_identity);

    let fw = client();
    assert!(std::ptr::eq(&fw.control_points, fw.flags()));
}

#[test]
fn register_target_exists_with_local_mode_recorded_and_traced() {
    let d = load_descriptor();
    let entry = d
        .client
        .methods
        .iter()
        .find(|m| m.name == "registerTarget")
        .expect("registerTarget must be declared under client.methods");
    assert_eq!(entry.local_mode.as_deref(), Some("recorded-and-traced"));

    // registerTarget's "recorded-and-traced" claim is specifically about
    // LOCAL mode (spec/modes.md) — client() here is backed by
    // InMemoryAdapter (the fixture/test double, not a mode), which has no
    // register_target override and correctly degrades via the trait
    // default; init_fireweave(InitOptions::local()) exercises the real
    // FireweaveLocalAdapter this claim is about.
    let fw = fireweave::init_fireweave(fireweave::InitOptions::local()).unwrap();
    let result = fw.register_target("user_1", None);
    assert!(result.ok);
}

/// Task-12 review regression test: `spec/modes.md` requires "The recorded
/// set MUST be readable (`getRegisteredTargets`) so tests can assert
/// registration without capturing stdout." Reachable through the
/// sanctioned entry point (`init_fireweave`) via the SAME accessor node's
/// own test suite uses on the equivalent field
/// (`client.runtime.adapter as FireweaveLocalAdapter`, an unchecked TS
/// cast) — `AsAny::as_any()` (a `BackendAdapter` supertrait, blanket-
/// implemented for every adapter) gives Rust a CHECKED downcast from
/// `FireweaveRuntime::adapter()`'s `&dyn BackendAdapter` back to the
/// concrete `FireweaveLocalAdapter`, mirroring go's type assertion / java's
/// `instanceof`-checked cast on their own identically-shaped
/// `Runtime.Adapter()`/`getAdapter()` accessors. Before this fix there was
/// no path from `FireweaveClient`/`FireweaveRuntime` back to
/// `FireweaveLocalAdapter::registered_targets()` at all — a caller
/// following the spec's own contract (and the README's local-mode
/// quick-start) had no way to verify registration except by capturing the
/// `[fireweave:local]` trace line, exactly what the spec forbids.
#[test]
fn registered_target_is_readable_through_the_sanctioned_entry_point_after_client_register_target() {
    let fw = fireweave::init_fireweave(fireweave::InitOptions::local()).unwrap();

    let mut properties = serde_json::Map::new();
    properties.insert("plan".to_string(), fireweave::JsonValue::from("pro"));
    let options = fireweave::RegisterTargetOptions {
        properties: Some(properties),
        ..Default::default()
    };
    let result = fw.register_target("user_42", Some(&options));
    assert!(result.ok);

    let local_adapter = fw
        .runtime()
        .adapter()
        .as_any()
        .downcast_ref::<fireweave::FireweaveLocalAdapter>()
        .expect("local mode must be backed by FireweaveLocalAdapter");
    let recorded = local_adapter.registered_targets();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].targeting_key, "user_42");
    assert_eq!(
        recorded[0].properties.get("plan"),
        Some(&fireweave::JsonValue::from("pro"))
    );
}

#[test]
fn must_not_expose_list_matches_the_fixed_v1_scope_boundary() {
    let d = load_descriptor();
    assert_eq!(
        d.client.must_not_expose,
        vec![
            "releases",
            "exposures",
            "signals",
            "capabilities",
            "guardrails",
            "FireweaveProvider",
            "FireweaveWebProvider"
        ]
    );
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

#[test]
fn must_not_expose_cut_namespaces_and_provider_types_are_absent_from_source() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut haystack = String::new();
    for file in rust_files(&root) {
        haystack.push_str(&fs::read_to_string(&file).expect("read source file"));
        haystack.push('\n');
    }

    let forbidden_patterns = [
        "fn releases(",
        "fn exposures(",
        "fn signals(",
        "fn capabilities(",
        "fn guardrails(",
        "struct Releases",
        "struct Exposures",
        "struct Signals",
        "struct Capabilities",
        "struct Guardrails",
        "struct FireweaveProvider",
        "struct FireweaveWebProvider",
        "mod openfeature",
    ];
    let offenders: Vec<&str> = forbidden_patterns
        .iter()
        .copied()
        .filter(|p| haystack.contains(p))
        .collect();
    assert!(
        offenders.is_empty(),
        "v1 scope violation — found item-definition shapes: {offenders:?}"
    );
}

#[test]
fn compatibility_cell_is_green_for_rust() {
    let d = load_descriptor();
    assert_eq!(
        d.compatibility.get("rust").map(String::as_str),
        Some("green"),
        r#"compatibility.rust must be "green""#
    );
}
