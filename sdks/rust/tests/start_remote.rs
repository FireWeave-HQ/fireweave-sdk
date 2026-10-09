//! The start profile in remote mode against a real loopback HTTP server
//! speaking the Fireweave remote protocol (go: `fw/remote_test.go`, node:
//! `test/integration/start-remote.test.ts`). Every request goes over a real
//! socket through the unchanged core remote adapter (`ureq`). std only: the
//! stub is a `TcpListener` thread, like `conformance/fake_server.rs`.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;

use fireweave::start::{
    self, define_control_points, env_map, LocalControlPoint, LogFn, StartOptions, StartState,
};
use fireweave::{redact_secrets, ErrorKind, EvaluationContext, JsonValue, Mode};

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

fn fresh() -> (MutexGuard<'static, ()>, Recorder) {
    let guard = TEST_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    start::reset_for_tests();
    (guard, Recorder::default())
}

/// A loopback fw-server stub: checks the bearer key, answers
/// `/v1/control-points/evaluate` from a fixed value table and records
/// `/v1/targets/register` bodies.
struct Stub {
    url: String,
    host: String,
    registered: Arc<Mutex<Vec<JsonValue>>>,
    auth_headers: Arc<Mutex<Vec<String>>>,
    /// When set, every request gets this status line regardless of its key.
    forced: Arc<Mutex<Option<&'static str>>>,
}

impl Stub {
    fn start(key: &'static str) -> Stub {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub");
        let addr = listener.local_addr().expect("local addr");
        let registered = Arc::new(Mutex::new(Vec::new()));
        let auth_headers = Arc::new(Mutex::new(Vec::new()));
        let forced = Arc::new(Mutex::new(None));
        let reg = Arc::clone(&registered);
        let auth = Arc::clone(&auth_headers);
        let force = Arc::clone(&forced);
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                handle(stream, key, &reg, &auth, &force);
            }
        });
        Stub {
            url: format!("http://{addr}"),
            host: addr.ip().to_string(),
            registered,
            auth_headers,
            forced,
        }
    }

    fn force(&self, status: Option<&'static str>) {
        *self.forced.lock().unwrap_or_else(PoisonError::into_inner) = status;
    }

    fn requests(&self) -> usize {
        self.auth_headers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }

    fn registered(&self) -> Vec<JsonValue> {
        self.registered
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

fn read_request(stream: &mut TcpStream) -> Option<(String, String, String)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    let header_end = loop {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let content_length: usize = head
        .lines()
        .find_map(|l| {
            l.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .and_then(|v| v.trim().parse().ok())
        })
        .unwrap_or(0);
    let body_start = header_end + 4;
    while buf.len() < body_start + content_length {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let path = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("")
        .to_string();
    let authorization = head
        .lines()
        .find_map(|l| {
            let (name, value) = l.split_once(':')?;
            name.eq_ignore_ascii_case("authorization")
                .then(|| value.trim().to_string())
        })
        .unwrap_or_default();
    let body = String::from_utf8_lossy(&buf[body_start..]).to_string();
    Some((path, authorization, body))
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn handle(
    mut stream: TcpStream,
    key: &str,
    registered: &Mutex<Vec<JsonValue>>,
    auth_headers: &Mutex<Vec<String>>,
    forced: &Mutex<Option<&'static str>>,
) {
    let Some((path, authorization, body)) = read_request(&mut stream) else {
        return;
    };
    auth_headers
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push(authorization.clone());
    if let Some(status) = *forced.lock().unwrap_or_else(PoisonError::into_inner) {
        respond(&mut stream, status, "{}");
        return;
    }
    if authorization != format!("Bearer {key}") {
        respond(&mut stream, "401 Unauthorized", "{}");
        return;
    }
    let body: JsonValue = serde_json::from_str(&body).unwrap_or(JsonValue::Null);
    match path.as_str() {
        "/v1/control-points/evaluate" => {
            let mut decisions = Vec::new();
            for k in body["controlPointKeys"]
                .as_array()
                .cloned()
                .unwrap_or_default()
            {
                let k = k.as_str().unwrap_or_default().to_string();
                let value = match k.as_str() {
                    "fw-bool-on" => Some(JsonValue::Bool(true)),
                    "fw-string-theme" => Some(JsonValue::from("dark")),
                    _ => None,
                };
                decisions.push(serde_json::json!({
                    "controlPointKey": k,
                    "value": value.clone().unwrap_or(JsonValue::Null),
                    "found": value.is_some(),
                    "enabled": true,
                    "reason": "TARGETING_MATCH",
                }));
            }
            let reply = serde_json::json!({ "decisions": decisions }).to_string();
            respond(&mut stream, "200 OK", &reply);
        }
        "/v1/targets/register" => {
            registered
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(body);
            respond(&mut stream, "200 OK", r#"{"ok":true}"#);
        }
        _ => respond(&mut stream, "404 Not Found", "{}"),
    }
}

fn ctx(key: &str) -> EvaluationContext {
    EvaluationContext::new().with_targeting_key(key)
}

fn with_process_env<R>(pairs: &[(&str, &str)], f: impl FnOnce() -> R) -> R {
    const NAMES: [&str; 9] = [
        "FIREWEAVE_KEY",
        "FIREWEAVE_URL",
        "FIREWEAVE_ENV",
        "FIREWEAVE_INSTANCE_ID",
        "APP_ENV",
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

#[test]
fn remote_start_evaluates_over_the_wire_and_ignores_flag_values() {
    let (_g, rec) = fresh();
    let key = "project-api-key_integration";
    let stub = Stub::start(key);

    start::start(StartOptions {
        key: Some(key.into()),
        url: Some(stub.url.clone()),
        env: Some(env_map([("APP_ENV", "production")])),
        control_points: define_control_points([("fw-bool-on", LocalControlPoint::local(false))]),
        log: Some(rec.sink()),
        ..Default::default()
    })
    .unwrap();

    let cp = start::control_points();
    assert!(
        cp.get_boolean_value("fw-bool-on", false, Some(&ctx("user-1"))),
        "the remote value must win over the control points' local value"
    );
    assert_eq!(
        cp.get_string_value("fw-string-theme", "light", Some(&ctx("user-1"))),
        "dark"
    );
    let d = cp.get_boolean_details("not-there", false, Some(&ctx("user-1")));
    assert_eq!(d.error_kind, Some(ErrorKind::ControlPointNotFound));
    assert_eq!(
        rec.count("is not in your control points"),
        0,
        "the missing-from-control-points warning is local mode only"
    );
    // Remote mode needs a targeting key: the core's InvalidContext, served
    // as the default.
    let d = cp.get_boolean_details("fw-bool-on", false, None);
    assert_eq!(d.error_kind, Some(ErrorKind::InvalidContext));
    assert_eq!(d.value, JsonValue::Bool(false));

    start::identify("user-1", [("plan", "pro")]).unwrap();
    let reg = stub.registered();
    assert_eq!(reg.len(), 1, "{reg:?}");
    assert_eq!(reg[0]["targetingKey"], "user-1");
    assert_eq!(reg[0]["kind"], "user");
    assert_eq!(reg[0]["properties"]["plan"], "pro");

    let s = start::status();
    assert_eq!(s.state, StartState::Ready);
    assert_eq!(s.mode, Some(Mode::Remote));
    assert_eq!(s.mode_source.as_deref(), Some("key"));
    assert_eq!(s.endpoint_source.as_deref(), Some("StartOptions.url"));
    assert_eq!(s.host.as_deref(), Some(stub.host.as_str()));
    assert_eq!(s.key_source.as_deref(), Some("StartOptions.key"));
    assert_eq!(s.control_point_count, 1);
    let rendered = format!("{s:?}");
    assert!(!rendered.contains(key), "{rendered}");
    assert!(rec.lines().iter().all(|l| !l.contains(key)));

    start::shutdown();
    let d = cp.get_boolean_details("fw-bool-on", false, Some(&ctx("user-1")));
    assert_eq!(d.error_kind, Some(ErrorKind::AlreadyClosed));
}

#[test]
fn remote_start_from_the_environment_with_a_legacy_key() {
    let (_g, rec) = fresh();
    let key = "project-api-key_legacy";
    let stub = Stub::start(key);
    let url_with_slash = format!("{}/", stub.url);
    let options = || StartOptions {
        env: Some(env_map([
            ("FW_PROJECT_API_KEY", key),
            ("FIREWEAVE_URL", url_with_slash.as_str()),
        ])),
        log: Some(rec.sink()),
        ..Default::default()
    };

    start::start(options()).unwrap();
    assert!(start::control_points().get_boolean_value("fw-bool-on", false, Some(&ctx("u"))));
    let s = start::status();
    assert_eq!(s.key_source.as_deref(), Some("FW_PROJECT_API_KEY"));
    assert_eq!(s.endpoint_source.as_deref(), Some("FIREWEAVE_URL"));

    // The legacy warning is logged once per process, even across a restart.
    start::shutdown();
    start::start(options()).unwrap();
    assert_eq!(
        rec.count("FW_PROJECT_API_KEY is a legacy name"),
        1,
        "{:?}",
        rec.lines()
    );
    assert!(rec.lines().iter().all(|l| !l.contains(key)));
}

#[test]
fn a_rejected_key_never_fails_a_read() {
    let (_g, rec) = fresh();
    let stub = Stub::start("project-api-key_right");
    start::start(StartOptions {
        key: Some("project-api-key_wrong".into()),
        url: Some(stub.url.clone()),
        env: Some(env_map(std::iter::empty::<(&str, &str)>())),
        log: Some(rec.sink()),
        ..Default::default()
    })
    .unwrap();
    let cp = start::control_points();
    assert!(cp.get_boolean_value("fw-bool-on", true, Some(&ctx("u"))));
    assert!(!cp.get_boolean_value("fw-bool-on", false, Some(&ctx("u"))));
    let d = cp.get_boolean_details("fw-bool-on", false, Some(&ctx("u")));
    assert_eq!(d.error_kind, Some(ErrorKind::Authentication));
    let err = start::identify("u", [("a", "b")]).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Authentication);
    // The wrong key went over the wire as the bearer token, and nowhere else.
    let auth = stub
        .auth_headers
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    assert!(auth.iter().all(|h| h == "Bearer project-api-key_wrong"));
    assert!(d
        .error_message
        .as_deref()
        .is_some_and(|m| !m.contains("project-api-key_wrong")));
}

#[test]
fn an_implicit_start_reads_the_key_and_url_from_the_process_environment() {
    let (_g, _rec) = fresh();
    let key = "project-api-key_from_process";
    let stub = Stub::start(key);
    with_process_env(
        &[("FIREWEAVE_KEY", key), ("FIREWEAVE_URL", &stub.url)],
        || {
            assert!(start::control_points().get_boolean_value(
                "fw-bool-on",
                false,
                Some(&ctx("u"))
            ));
            let s = start::status();
            assert_eq!(s.mode, Some(Mode::Remote));
            assert_eq!(s.key_source.as_deref(), Some("FIREWEAVE_KEY"));
            assert_eq!(s.endpoint_source.as_deref(), Some("FIREWEAVE_URL"));

            // An explicit start that resolves to the same config is a no-op,
            // control_points included: remote mode ignores them.
            start::start(StartOptions {
                control_points: define_control_points([(
                    "fw-bool-on",
                    LocalControlPoint::local(true),
                )]),
                ..Default::default()
            })
            .unwrap();
            // A different endpoint is a conflict that names the field only.
            let err = start::start(StartOptions {
                url: Some("https://fw.example.com".into()),
                ..Default::default()
            })
            .unwrap_err();
            assert!(err.message.contains("differs in url"), "{}", err.message);
            assert!(!err.message.contains("example.com"), "{}", err.message);
        },
    );
}

#[test]
fn a_custom_endpoint_outside_loopback_must_use_https() {
    let (_g, _rec) = fresh();
    let err = start::start(StartOptions {
        key: Some("project-api-key_x".into()),
        url: Some("http://fw.example.com".into()),
        env: Some(env_map(std::iter::empty::<(&str, &str)>())),
        log: Some(Arc::new(|_line: &str| {})),
        ..Default::default()
    })
    .unwrap_err();
    assert_eq!(err.kind, ErrorKind::Configuration);
    assert!(err.message.contains("must use https"), "{}", err.message);
    assert_eq!(start::status().state, StartState::Failed);
}

#[test]
fn the_default_endpoint_is_the_channel_host_and_needs_no_custom_allowlist() {
    let (_g, _rec) = fresh();
    // Start only: no read, so nothing goes over the network.
    start::start(StartOptions {
        key: Some("project-api-key_x".into()),
        env: Some(env_map(std::iter::empty::<(&str, &str)>())),
        log: Some(Arc::new(|_line: &str| {})),
        ..Default::default()
    })
    .unwrap();
    let s = start::status();
    let expected = start::sdk_channel().default_url();
    assert_eq!(
        Some(format!("https://{}", s.host.as_deref().unwrap_or_default())).as_deref(),
        Some(expected)
    );
    assert_eq!(
        s.endpoint_source,
        Some(format!("SDK channel ({})", start::sdk_channel()))
    );
    start::shutdown();
}

// ------------------------------------------------- SP-27: refused key signal

/// Starts from the environment, as a deploy does: the key comes from
/// `FIREWEAVE_KEY`.
fn start_from_env(key: &str, url: &str, rec: &Recorder) {
    start::start(StartOptions {
        env: Some(env_map([("FIREWEAVE_KEY", key), ("FIREWEAVE_URL", url)])),
        log: Some(rec.sink()),
        ..Default::default()
    })
    .unwrap();
}

fn assert_no_key(lines: &[String], keys: &[&str]) {
    for line in lines {
        assert!(keys.iter().all(|k| !line.contains(k)), "{line}");
        assert_eq!(
            &redact_secrets(line),
            line,
            "a signal line survives redaction"
        );
    }
}

#[test]
fn a_rejected_key_is_logged_once_naming_fireweave_key_and_shows_in_status() {
    let (_g, rec) = fresh();
    let stub = Stub::start("project-api-key_right");
    let wrong = "project-api-key_wrong_signal";
    start_from_env(wrong, &stub.url, &rec);
    assert_eq!(start::status().last_error_kind, None, "nothing failed yet");

    let cp = start::control_points();
    for _ in 0..5 {
        assert!(!cp.get_boolean_value("fw-bool-on", false, Some(&ctx("u"))));
    }
    assert_eq!(
        start::identify("u", [("a", "b")]).unwrap_err().kind,
        ErrorKind::Authentication
    );
    assert_eq!(stub.requests(), 6, "every read really went to fw-server");

    let lines = rec.lines();
    assert_eq!(
        rec.count("rejected the key from FIREWEAVE_KEY (401, Authentication)"),
        1,
        "{lines:?}"
    );
    assert_eq!(
        rec.count("(401, "),
        1,
        "repeated failures log once: {lines:?}"
    );
    assert_eq!(
        rec.count(&format!("fw-server at {}", stub.host)),
        1,
        "{lines:?}"
    );
    assert_no_key(&lines, &[wrong, "project-api-key_right"]);

    let s = start::status();
    assert_eq!(s.last_error_kind, Some(ErrorKind::Authentication));
    let rendered = format!("{s:?}");
    assert!(
        rendered.contains("last_error_kind: Some(Authentication)"),
        "{rendered}"
    );
    assert!(!rendered.contains(wrong), "{rendered}");
}

#[test]
fn each_kind_is_logged_once_for_the_life_of_the_process_and_status_keeps_the_latest() {
    let (_g, rec) = fresh();
    let key = "project-api-key_kinds";
    let stub = Stub::start(key);
    start_from_env(key, &stub.url, &rec);
    let cp = start::control_points();
    let read = || cp.get_boolean_value("fw-bool-on", false, Some(&ctx("u")));
    assert!(read());
    assert_eq!(start::status().last_error_kind, None);

    stub.force(Some("429 Too Many Requests"));
    read();
    read();
    assert_eq!(
        start::status().last_error_kind,
        Some(ErrorKind::RateLimited)
    );
    stub.force(Some("503 Service Unavailable"));
    read();
    assert_eq!(
        start::status().last_error_kind,
        Some(ErrorKind::BackendUnavailable)
    );
    stub.force(Some("403 Forbidden"));
    read();
    assert_eq!(
        start::status().last_error_kind,
        Some(ErrorKind::Authorization)
    );

    // A restart in the same process starts with no remote failure and does
    // not log a kind again.
    start::shutdown();
    stub.force(None);
    start_from_env(key, &stub.url, &rec);
    assert_eq!(start::status().last_error_kind, None);
    stub.force(Some("429 Too Many Requests"));
    read();
    assert_eq!(
        start::status().last_error_kind,
        Some(ErrorKind::RateLimited)
    );

    let lines = rec.lines();
    assert_eq!(rec.count("(429, RateLimited)"), 1, "{lines:?}");
    assert_eq!(rec.count("(BackendUnavailable)"), 1, "{lines:?}");
    assert_eq!(
        rec.count("refused the key from FIREWEAVE_KEY (403, Authorization)"),
        1,
        "{lines:?}"
    );
    assert_eq!(lines.len(), 3, "{lines:?}");
    assert_no_key(&lines, &[key]);
}

#[test]
fn an_unreachable_endpoint_names_the_host_never_the_key() {
    let (_g, rec) = fresh();
    let dead = {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        format!("http://{}", listener.local_addr().expect("addr"))
    };
    let key = "project-api-key_unreachable";
    start_from_env(key, &dead, &rec);
    let cp = start::control_points();
    assert!(!cp.get_boolean_value("fw-bool-on", false, Some(&ctx("u"))));
    assert!(!cp.get_boolean_value("fw-bool-on", false, Some(&ctx("u"))));

    assert_eq!(start::status().last_error_kind, Some(ErrorKind::Network));
    let lines = rec.lines();
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert!(
        lines[0].contains("Could not reach fw-server at 127.0.0.1 (Network)"),
        "{lines:?}"
    );
    assert!(lines[0].contains("FIREWEAVE_URL"), "{lines:?}");
    assert_no_key(&lines, &[key]);
}
