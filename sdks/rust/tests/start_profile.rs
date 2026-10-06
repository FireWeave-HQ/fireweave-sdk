//! The start profile's facade (`fireweave::start`): one process-wide
//! singleton, so every test here takes `TEST_LOCK` and resets it first
//! (go: `fw/fw_test.go`, node: `test/unit/start-*.test.ts`).
//!
//! Tests that exercise the implicit (env-only) start set real process
//! environment variables, saved and restored around the test, under the
//! same lock.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use fireweave::start::{
    self, define_control_points, env_map, LocalControlPoint, LogFn, StartOptions, StartState,
};
use fireweave::{reason, ErrorKind, EvaluationContext, FlagType, JsonValue, Mode};

static TEST_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Default)]
struct Recorder(Arc<Mutex<Vec<String>>>);

impl Recorder {
    fn sink(&self) -> LogFn {
        let lines = Arc::clone(&self.0);
        Arc::new(move |line: &str| {
            lines
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(line.to_string())
        })
    }

    fn lines(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn count(&self, needle: &str) -> usize {
        self.lines().iter().filter(|l| l.contains(needle)).count()
    }
}

/// Serializes the test and resets the singleton.
fn fresh() -> (MutexGuard<'static, ()>, Recorder) {
    let guard = TEST_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    start::reset_for_tests();
    (guard, Recorder::default())
}

const DEV: [(&str, &str); 1] = [("FIREWEAVE_ENV", "development")];

fn local_options(rec: &Recorder) -> StartOptions {
    StartOptions {
        control_points: define_control_points([
            ("fw-on", LocalControlPoint::local(true)),
            (
                "fw-off",
                LocalControlPoint::local(false).describe("kept off locally"),
            ),
        ]),
        env: Some(env_map(DEV)),
        log: Some(rec.sink()),
        ..Default::default()
    }
}

fn ctx(key: &str) -> EvaluationContext {
    EvaluationContext::new().with_targeting_key(key)
}

/// Every variable the start profile reads, cleared (or set from `pairs`)
/// for the duration of `f`, then restored.
fn with_process_env<R>(pairs: &[(&str, &str)], f: impl FnOnce() -> R) -> R {
    const NAMES: [&str; 10] = [
        "FIREWEAVE_KEY",
        "FIREWEAVE_URL",
        "FIREWEAVE_ENV",
        "FIREWEAVE_INSTANCE_ID",
        "APP_ENV",
        "NODE_ENV",
        "FW_PROJECT_API_KEY",
        "FW_API_URL",
        "FW_ATTEST_URL",
        "FW_ENV",
    ];
    let saved: Vec<(&str, Option<std::ffi::OsString>)> =
        NAMES.iter().map(|n| (*n, std::env::var_os(n))).collect();
    for name in NAMES {
        std::env::remove_var(name);
    }
    for (k, v) in pairs {
        std::env::set_var(k, v);
    }
    let result = catch_unwind(AssertUnwindSafe(f));
    for (name, value) in saved {
        match value {
            Some(v) => std::env::set_var(name, v),
            None => std::env::remove_var(name),
        }
    }
    match result {
        Ok(r) => r,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

// ----------------------------------------------------------------- local

#[test]
fn start_local_serves_each_flag_and_logs_one_local_line() {
    let (_g, rec) = fresh();
    start::start(local_options(&rec)).unwrap();
    let cp = start::control_points();
    assert!(cp.get_boolean_value("fw-on", false, Some(&ctx("u1"))));
    assert!(!cp.get_boolean_value("fw-off", true, Some(&ctx("u1"))));
    // Local mode needs no targeting key.
    assert!(cp.get_boolean_value("fw-on", false, None));
    let d = cp.get_boolean_details("fw-on", false, None);
    assert_eq!(d.reason, reason::STATIC);

    assert_eq!(
        rec.count("[fireweave:local] Local mode"),
        1,
        "{:?}",
        rec.lines()
    );
    assert_eq!(
        rec.count(
            r#"no FIREWEAVE_KEY; environment "development" from FIREWEAVE_ENV). Serving 2 control points"#
        ),
        1,
        "{:?}",
        rec.lines()
    );
}

#[test]
fn a_local_read_of_an_undeclared_key_gets_the_default_and_warns_once() {
    let (_g, rec) = fresh();
    start::start(local_options(&rec)).unwrap();
    let cp = start::control_points();
    assert!(!cp.get_boolean_value("not-declared", false, None));
    assert!(cp.get_boolean_value("not-declared", true, None));
    let d = cp.get_boolean_details("not-declared", false, None);
    assert_eq!(d.reason, reason::DEFAULT);
    assert_eq!(
        rec.count(
            r#""not-declared" is not in your control points (src/fireweave_control_points.rs)"#
        ),
        1,
        "{:?}",
        rec.lines()
    );
    // A declared key never warns.
    let _ = cp.get_boolean_value("fw-on", false, None);
    assert_eq!(rec.count("is not in your control points"), 1);
}

#[test]
fn mode_local_needs_no_environment_name_and_ignores_a_key_once() {
    let (_g, rec) = fresh();
    let key = "project-api-key_should_never_print";
    start::start(StartOptions {
        mode: Some(Mode::Local),
        control_points: define_control_points([("fw-on", LocalControlPoint::local(true))]),
        env: Some(env_map([("FIREWEAVE_KEY", key), ("APP_ENV", "production")])),
        log: Some(rec.sink()),
        ..Default::default()
    })
    .unwrap();
    assert!(start::control_points().get_boolean_value("fw-on", false, None));
    assert_eq!(
        rec.count("StartOptions.mode Local ignores the key from FIREWEAVE_KEY"),
        1
    );
    assert_eq!(rec.count("Local mode (StartOptions.mode Local)"), 1);
    assert!(rec.lines().iter().all(|l| !l.contains(key)));
    let s = start::status();
    assert_eq!(s.mode, Some(Mode::Local));
    assert_eq!(s.mode_source.as_deref(), Some("option"));
    assert_eq!(s.key_source.as_deref(), Some("none"));
}

#[test]
fn control_points_is_the_core_namespace_on_the_permanent_client() {
    let (_g, rec) = fresh();
    let before: *const _ = start::control_points();
    let client_before: *const _ = start::client();
    start::start(local_options(&rec)).unwrap();
    assert!(std::ptr::eq(before, start::control_points()));
    assert!(std::ptr::eq(
        &start::client().control_points,
        start::control_points()
    ));
    assert!(std::ptr::eq(client_before, start::client()));
}

#[test]
fn every_read_method_works_through_the_facade() {
    let (_g, rec) = fresh();
    start::start(local_options(&rec)).unwrap();
    let cp = start::control_points();
    let c = ctx("u1");
    assert!(cp.get_boolean_value("fw-on", false, Some(&c)));
    // Local seeds are booleans: the other types get their defaults.
    assert_eq!(cp.get_string_value("fw-str", "d", Some(&c)), "d");
    assert_eq!(cp.get_number_value("fw-num", 1.5, Some(&c)), 1.5);
    let obj = serde_json::json!({"a": 1});
    assert_eq!(cp.get_object_value("fw-obj", obj.clone(), Some(&c)), obj);
    assert_eq!(cp.get_boolean_details("fw-on", false, Some(&c)).value, true);
    assert_eq!(
        cp.get_string_details("fw-str", "d", Some(&c)).value,
        JsonValue::from("d")
    );
    assert_eq!(
        cp.get_number_details("fw-num", 2.0, Some(&c)).value,
        JsonValue::from(2.0)
    );
    assert_eq!(
        cp.get_object_details("fw-obj", obj.clone(), Some(&c)).value,
        obj
    );
    let d = cp.evaluate(
        "fw-on",
        FlagType::Boolean,
        JsonValue::Bool(false),
        Some(&c),
        None,
    );
    assert_eq!(d.value, JsonValue::Bool(true));
    // A wrong-typed read of a seeded flag is the core's TypeMismatch.
    let d = cp.get_string_details("fw-on", "d", Some(&c));
    assert_eq!(d.error_kind, Some(ErrorKind::TypeMismatch));
}

// --------------------------------------------------------- idempotency

#[test]
fn a_second_identical_start_is_a_no_op() {
    let (_g, rec) = fresh();
    start::start(local_options(&rec)).unwrap();
    start::start(local_options(&rec)).unwrap();
    assert_eq!(rec.count("[fireweave:local] Local mode"), 1);
    assert_eq!(start::status().state, StartState::Ready);
}

#[test]
fn a_second_start_with_different_flags_is_a_conflict_and_keeps_the_running_client() {
    let (_g, rec) = fresh();
    start::start(local_options(&rec)).unwrap();
    let mut other = local_options(&rec);
    other.control_points = define_control_points([("fw-on", LocalControlPoint::local(false))]);
    let err = start::start(other).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Configuration);
    assert!(
        err.message
            .contains("already called with a different configuration (control_points)"),
        "{}",
        err.message
    );
    assert!(start::control_points().get_boolean_value("fw-on", false, None));
    assert_eq!(start::status().state, StartState::Ready);
}

#[test]
fn a_different_key_is_a_conflict_but_the_log_sink_is_not() {
    let (_g, rec) = fresh();
    let base = StartOptions {
        key: Some("project-api-key_one".into()),
        url: Some("http://127.0.0.1:9".into()),
        env: Some(env_map(std::iter::empty::<(&str, &str)>())),
        log: Some(rec.sink()),
        ..Default::default()
    };
    start::start(base.clone()).unwrap();

    let other_sink = Recorder::default();
    start::start(StartOptions {
        log: Some(other_sink.sink()),
        ..base.clone()
    })
    .unwrap();

    let err = start::start(StartOptions {
        key: Some("project-api-key_two".into()),
        ..base
    })
    .unwrap_err();
    assert!(err.message.contains("(key)"), "{}", err.message);
    assert!(!err.message.contains("project-api-key_one"));
    assert!(!err.message.contains("project-api-key_two"));
}

#[test]
fn the_first_start_keeps_its_log_sink() {
    let (_g, rec) = fresh();
    start::start(local_options(&rec)).unwrap();
    let second = Recorder::default();
    let mut again = local_options(&rec);
    again.log = Some(second.sink());
    start::start(again).unwrap();
    let _ = start::control_points().get_boolean_value("undeclared", false, None);
    assert_eq!(rec.count("\"undeclared\" is not in your control points"), 1);
    assert!(second.lines().is_empty(), "{:?}", second.lines());
}

// ------------------------------------------------------------ failures

#[test]
fn bad_config_fails_start_and_reads_serve_defaults() {
    let (_g, rec) = fresh();
    let err = start::start(StartOptions {
        env: Some(env_map([("APP_ENV", "production")])),
        log: Some(rec.sink()),
        ..Default::default()
    })
    .unwrap_err();
    assert_eq!(err.kind, ErrorKind::Configuration);
    assert_eq!(err.openfeature_error_code(), "PROVIDER_FATAL");
    assert!(
        err.message.starts_with("FIREWEAVE_KEY is not set"),
        "{}",
        err.message
    );

    let cp = start::control_points();
    assert!(cp.get_boolean_value("any", true, None));
    assert_eq!(cp.get_string_value("any", "fallback", None), "fallback");
    let d = cp.get_boolean_details("any", false, None);
    assert_eq!(d.reason, reason::ERROR);
    assert_eq!(d.error_kind, Some(ErrorKind::Configuration));
    assert_eq!(d.value, JsonValue::Bool(false));

    let s = start::status();
    assert_eq!(s.state, StartState::Failed);
    assert!(s.error.unwrap().starts_with("FIREWEAVE_KEY is not set"));

    // A failed start is not retried implicitly by reads, but a corrected
    // explicit start succeeds.
    start::start(local_options(&rec)).unwrap();
    assert!(cp.get_boolean_value("fw-on", false, None));
}

#[test]
fn a_bad_flag_declaration_is_a_configuration_error_not_a_read_failure() {
    let (_g, _rec) = fresh();
    let err = start::try_define_control_points([("bad\nkey", LocalControlPoint::local(true))])
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::Configuration);
    let result = catch_unwind(|| define_control_points([("", LocalControlPoint::local(true))]));
    assert!(result.is_err());
}

// -------------------------------------------------------- implicit start

#[test]
fn a_read_before_start_starts_from_the_process_environment() {
    let (_g, rec) = fresh();
    with_process_env(&[("FIREWEAVE_ENV", "development")], || {
        assert_eq!(start::status().state, StartState::Unstarted);
        // Implicit start: local, no control points, so the default.
        assert!(!start::control_points().get_boolean_value("x", false, None));
        let s = start::status();
        assert_eq!(s.state, StartState::Ready);
        assert_eq!(s.mode, Some(Mode::Local));
        assert_eq!(s.environment.as_deref(), Some("development"));

        // An explicit start that agrees is a no-op (control_points differ, but they
        // are part of the signature in local mode: none == none here).
        start::start(StartOptions {
            log: Some(rec.sink()),
            ..Default::default()
        })
        .unwrap();

        // One that disagrees says why.
        let err = start::start(local_options(&rec)).unwrap_err();
        assert!(
            err.message
                .contains("A control point was read before fireweave::start::start ran"),
            "{}",
            err.message
        );
        assert!(
            err.message.contains("differs in control_points"),
            "{}",
            err.message
        );
    });
}

#[test]
fn a_failed_implicit_start_serves_defaults_and_never_panics() {
    let (_g, _rec) = fresh();
    with_process_env(&[("APP_ENV", "production")], || {
        let cp = start::control_points();
        for _ in 0..3 {
            assert!(cp.get_boolean_value("x", true, None));
            let d = cp.get_number_details("x", 3.0, None);
            assert_eq!(d.error_kind, Some(ErrorKind::Configuration));
            assert_eq!(d.value, JsonValue::from(3.0));
        }
        assert_eq!(start::status().state, StartState::Failed);
        // identify also never panics.
        let err = start::identify("user-1", [("plan", "pro")]).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Configuration);
    });
}

#[test]
fn an_implicit_start_also_comes_from_identify() {
    let (_g, _rec) = fresh();
    with_process_env(&[("APP_ENV", "test")], || {
        start::identify("user-1", std::iter::empty::<(&str, &str)>()).unwrap();
        assert_eq!(start::status().state, StartState::Ready);
    });
}

// ------------------------------------------------- shutdown and restart

#[test]
fn a_captured_client_works_across_start_shutdown_and_restart() {
    let (_g, rec) = fresh();
    let cp = start::control_points();
    start::start(local_options(&rec)).unwrap();
    assert!(cp.get_boolean_value("fw-on", false, None));

    start::shutdown();
    assert_eq!(start::status().state, StartState::Shutdown);
    let d = cp.get_boolean_details("fw-on", false, None);
    assert_eq!(d.error_kind, Some(ErrorKind::AlreadyClosed));
    assert!(!cp.get_boolean_value("fw-on", false, None));
    start::shutdown(); // idempotent

    // A restart starts fresh, here with different control_points: no conflict.
    let mut again = local_options(&rec);
    again.control_points = define_control_points([
        ("fw-on", LocalControlPoint::local(false)),
        ("fw-new", LocalControlPoint::local(true)),
    ]);
    start::start(again).unwrap();
    assert!(!cp.get_boolean_value("fw-on", true, None));
    assert!(cp.get_boolean_value("fw-new", false, None));
    assert_eq!(start::status().control_point_count, 2);
}

#[test]
fn no_implicit_start_after_shutdown() {
    let (_g, _rec) = fresh();
    with_process_env(&[("FIREWEAVE_ENV", "development")], || {
        start::shutdown();
        let d = start::control_points().get_boolean_details("x", false, None);
        assert_eq!(d.error_kind, Some(ErrorKind::AlreadyClosed));
        assert_eq!(start::status().state, StartState::Shutdown);
    });
}

// ------------------------------------------------------------ identify

#[test]
fn identify_registers_a_user_target() {
    let (_g, rec) = fresh();
    start::start(local_options(&rec)).unwrap();
    start::identify("user-1", [("plan", "pro")]).unwrap();
    start::identify("user-2", [("seats", JsonValue::from(3))]).unwrap();
    let traces: Vec<String> = rec
        .lines()
        .into_iter()
        .filter(|l| l.contains("registerTarget"))
        .collect();
    assert_eq!(traces.len(), 2, "{traces:?}");
    assert!(
        traces[0].contains(r#"registerTarget user user-1 {"plan":"pro"}"#),
        "{}",
        traces[0]
    );
    assert!(traces[1].contains(r#"user-2 {"seats":3}"#), "{}", traces[1]);

    let err = start::identify("  ", std::iter::empty::<(&str, &str)>()).unwrap_err();
    assert_eq!(err.kind, ErrorKind::InvalidContext);
    assert_eq!(err.openfeature_error_code(), "TARGETING_KEY_MISSING");
}

// -------------------------------------------------------- instance key

#[test]
fn instance_key_order() {
    // Option.
    let (_g, rec) = fresh();
    let mut o = local_options(&rec);
    o.instance_id = Some(" cron-1 ".into());
    o.env = Some(env_map([
        ("FIREWEAVE_ENV", "dev"),
        ("FIREWEAVE_INSTANCE_ID", "worker-7"),
    ]));
    start::start(o).unwrap();
    assert_eq!(start::instance_key(), "cron-1");
    drop(_g);

    // FIREWEAVE_INSTANCE_ID, through the started configuration's env.
    let (_g, rec) = fresh();
    let mut o = local_options(&rec);
    o.env = Some(env_map([
        ("FIREWEAVE_ENV", "dev"),
        ("FIREWEAVE_INSTANCE_ID", " worker-7 "),
    ]));
    start::start(o).unwrap();
    assert_eq!(start::instance_key(), "worker-7");
    drop(_g);

    // An empty FIREWEAVE_INSTANCE_ID is unset: the host-name hash (or the
    // random fallback when this machine exposes no host name to std).
    let (_g, rec) = fresh();
    let mut o = local_options(&rec);
    o.env = Some(env_map([
        ("FIREWEAVE_ENV", "dev"),
        ("FIREWEAVE_INSTANCE_ID", "  "),
    ]));
    start::start(o).unwrap();
    let key = start::instance_key();
    let hex = key.strip_prefix("inst_").expect("inst_ prefix");
    assert!(hex.len() == 16 || hex.len() == 32, "{key}");
    assert!(hex.bytes().all(|b| b.is_ascii_hexdigit()), "{key}");
    // Stable for the life of the process, across shutdown and restart.
    assert_eq!(start::instance_key(), key);
    start::shutdown();
    assert_eq!(start::instance_key(), key);
}

#[test]
fn the_host_key_is_the_cross_language_hash_of_the_host_name() {
    let (_g, _rec) = fresh();
    // Linux exposes the kernel host name to std; elsewhere this test only
    // checks the shape (the hash itself is pinned by the unit tests).
    let host = std::fs::read_to_string("/proc/sys/kernel/hostname")
        .ok()
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty());
    with_process_env(&[], || {
        let key = start::instance_key();
        if let Some(host) = host {
            assert_eq!(key, format!("inst_{}", fnv1a64_reference(&host)));
        } else {
            assert!(key.starts_with("inst_"), "{key}");
        }
    });
}

/// An independent FNV-1a 64 written from the spec (offset basis, prime),
/// so the SDK's own implementation is checked against more than itself.
fn fnv1a64_reference(text: &str) -> String {
    const OFFSET: u64 = 14_695_981_039_346_656_037;
    const PRIME: u64 = 1_099_511_628_211;
    let hash = text
        .bytes()
        .fold(OFFSET, |h, b| (h ^ u64::from(b)).wrapping_mul(PRIME));
    format!("{hash:016x}")
}

#[test]
fn the_cross_language_vector_matches_node() {
    // Computed with sdks/node/src/start/instance.ts:
    //   deriveInstanceKey(undefined, n => n === 'HOSTNAME' ? 'api-pod-1' : undefined)
    //   -> { value: 'inst_8148fc8bb0e952ef', source: 'host' }
    assert_eq!(fnv1a64_reference("api-pod-1"), "8148fc8bb0e952ef");
}

#[test]
fn start_refuses_an_instance_id_that_differs_from_one_handed_out() {
    let (_g, rec) = fresh();
    with_process_env(&[("FIREWEAVE_INSTANCE_ID", "first")], || {
        assert_eq!(start::instance_key(), "first");
        let mut o = local_options(&rec);
        o.instance_id = Some("second".into());
        let err = start::start(o).unwrap_err();
        assert!(
            err.message.contains("StartOptions.instance_id differs"),
            "{}",
            err.message
        );
        let mut o = local_options(&rec);
        o.instance_id = Some("first".into());
        start::start(o).unwrap();
    });
}

// -------------------------------------------------------------- status

#[test]
fn status_before_any_start() {
    let (_g, _rec) = fresh();
    let s = start::status();
    assert_eq!(s.state, StartState::Unstarted);
    assert_eq!(s.mode, None);
    assert_eq!(s.sdk_version, start::sdk_version());
    assert_eq!(s.channel, start::sdk_channel());
    assert_eq!(s.control_point_count, 0);
    assert!(s.error.is_none());
}

#[test]
fn status_reports_the_local_decision() {
    let (_g, rec) = fresh();
    start::start(local_options(&rec)).unwrap();
    let s = start::status();
    assert_eq!(s.state, StartState::Ready);
    assert_eq!(s.mode, Some(Mode::Local));
    assert_eq!(s.mode_source.as_deref(), Some("environment"));
    assert_eq!(s.environment.as_deref(), Some("development"));
    assert_eq!(s.key_source.as_deref(), Some("none"));
    assert_eq!(s.host, None);
    assert_eq!(s.endpoint_source, None);
    assert_eq!(s.control_point_count, 2);
}

#[test]
fn sdk_version_is_the_crate_version() {
    let manifest =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")).unwrap();
    let version = manifest
        .lines()
        .find_map(|l| l.strip_prefix("version = \""))
        .and_then(|rest| rest.strip_suffix('"'))
        .expect("version line");
    assert_eq!(start::sdk_version(), version);
    assert_eq!(start::sdk_channel(), start::channel_for_version(version));
}

// --------------------------------------------------------- concurrency

#[test]
fn concurrent_reads_starts_and_status_are_race_free() {
    let (_g, rec) = fresh();
    // An empty process environment: a read that wins the race starts
    // implicitly and fails closed (no key, no environment name), never
    // reaching for a network.
    with_process_env(&[], || {
        std::thread::scope(|s| {
            for i in 0..8 {
                let rec = rec.clone();
                s.spawn(move || {
                    if i % 2 == 0 {
                        let _ = start::start(local_options(&rec));
                    }
                    for _ in 0..50 {
                        let _ = start::control_points().get_boolean_value("fw-on", false, None);
                        let _ = start::status();
                        let _ = start::instance_key();
                    }
                });
            }
        });
    });
    // Reads from threads that ran before any start may have started
    // implicitly from the process environment; either way the singleton
    // ends in a settled state and nothing panicked.
    let state = start::status().state;
    assert!(
        matches!(state, StartState::Ready | StartState::Failed),
        "{state:?}"
    );
    assert!(rec.count("[fireweave:local] Local mode") <= 1);
}

#[test]
fn a_log_sink_that_calls_back_into_the_facade_does_not_deadlock() {
    let (_g, _rec) = fresh();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen_in_sink = Arc::clone(&seen);
    let sink: LogFn = Arc::new(move |line: &str| {
        let state = start::status().state;
        let _ = start::instance_key();
        seen_in_sink
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(format!("{state:?} {line}"));
    });
    start::start(StartOptions {
        env: Some(env_map(DEV)),
        log: Some(sink),
        ..Default::default()
    })
    .unwrap();
    let _ = start::control_points().get_boolean_value("undeclared", false, None);
    start::identify("user-1", [("a", "b")]).unwrap();
    assert!(seen.lock().unwrap().len() >= 3);
}

#[test]
fn a_panicking_log_sink_never_reaches_a_read() {
    let (_g, _rec) = fresh();
    start::start(StartOptions {
        env: Some(env_map(DEV)),
        log: Some(Arc::new(|_line: &str| panic!("sink exploded"))),
        ..Default::default()
    })
    .unwrap();
    assert!(!start::control_points().get_boolean_value("undeclared", false, None));
    assert!(start::identify("user-1", [("a", "b")]).is_ok());
}
