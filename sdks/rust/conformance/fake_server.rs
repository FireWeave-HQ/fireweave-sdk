//! Hermetic in-process loopback HTTP/1.1 stub for the `faults` suite.
//!
//! The canonical dockerized `rust:1-slim` conformance run has no `node`
//! binary to spawn `test-server/implementation/server.mjs` with (unlike
//! node/python's runners) — mirroring go's fake `http.RoundTripper` /
//! java's in-process `com.sun.net.httpserver` stub, this is the same
//! "no node in the canonical dockerized image" workaround, solved with a
//! REAL loopback TCP server (std only) instead of faking ureq's transport
//! internals (ureq has no public transport-injection seam as simple as
//! Go's `http.RoundTripper`). The client side (`FireweaveRemoteAdapter`)
//! speaks genuinely real HTTP over a genuinely real socket to this stub —
//! only the process on the other end is scripted, exactly like harness.md
//! describes for go/java.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// Scripted response behavior for the NEXT request(s) this stub receives.
#[derive(Clone, Debug)]
pub enum FaultMode {
    /// A normal empty-decisions 200 response.
    Ok,
    /// Respond with this HTTP status and an empty JSON object body.
    HttpStatus(u16),
    /// Respond 200 with this literal (possibly non-JSON) body string.
    InvalidJson(String),
    /// Respond 200 with `{"decisions":[],"quotaLimited":true}`.
    QuotaLimited,
    /// Sleep this long before responding 200 with an empty-decisions body
    /// (the client is expected to have already given up via its own
    /// request timeout).
    Delay(Duration),
}

/// One shared, long-lived stub process (loopback, random port), matching
/// node/python's `_StubServer`/`_StubServer.instance()` singleton — a
/// single background thread accepts connections for the lifetime of the
/// conformance run; `set_fault` reconfigures how the NEXT connection is
/// answered.
pub struct FakeServer {
    pub url: String,
    fault: Arc<Mutex<FaultMode>>,
}

impl FakeServer {
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake conformance server");
        let addr = listener.local_addr().expect("fake server local_addr");
        let fault = Arc::new(Mutex::new(FaultMode::Ok));
        let fault_for_thread = fault.clone();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let mode = fault_for_thread
                    .lock()
                    .expect("fault lock poisoned")
                    .clone();
                handle_connection(stream, mode);
            }
        });
        FakeServer {
            url: format!("http://{addr}"),
            fault,
        }
    }

    pub fn set_fault(&self, mode: FaultMode) {
        *self.fault.lock().expect("fault lock poisoned") = mode;
    }
}

fn handle_connection(mut stream: TcpStream, mode: FaultMode) {
    // Consume the request fully (headers + declared body) so the client
    // sees a clean response; the fault mode is configured out-of-band via
    // `set_fault`, not derived from the request itself — this stub is a
    // script, not a real evaluator.
    read_http_request(&mut stream);

    if let FaultMode::Delay(delay) = mode {
        thread::sleep(delay);
    }
    let (status, body): (u16, String) = match mode {
        FaultMode::Ok => (200, r#"{"decisions":[]}"#.to_string()),
        FaultMode::HttpStatus(code) => (code, "{}".to_string()),
        FaultMode::InvalidJson(body) => (200, body),
        FaultMode::QuotaLimited => (200, r#"{"decisions":[],"quotaLimited":true}"#.to_string()),
        FaultMode::Delay(_) => (200, r#"{"decisions":[]}"#.to_string()),
    };
    let response = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        reason_phrase(status),
        body.len(),
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        401 => "Unauthorized",
        403 => "Forbidden",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        _ => "Error",
    }
}

/// Minimal HTTP/1.1 request reader: read headers until `\r\n\r\n`, then
/// read `Content-Length` bytes of body (if declared). Good enough for a
/// hermetic loopback test double talking to our own `ureq` client — not a
/// general-purpose HTTP server.
fn read_http_request(stream: &mut TcpStream) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 512];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                let Some(header_end) = find_subslice(&buf, b"\r\n\r\n") else {
                    continue;
                };
                let header_text = String::from_utf8_lossy(&buf[..header_end]);
                let content_length: usize = header_text
                    .lines()
                    .find_map(|line| {
                        let lower = line.to_ascii_lowercase();
                        lower
                            .strip_prefix("content-length:")
                            .and_then(|rest| rest.trim().parse().ok())
                    })
                    .unwrap_or(0);
                let body_start = header_end + 4;
                while buf.len() < body_start + content_length {
                    match stream.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        Err(_) => break,
                    }
                }
                break;
            }
            Err(_) => break,
        }
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Binds an ephemeral loopback port and immediately releases it, producing
/// a real `ECONNREFUSED` on connect — no fake transport involved for the
/// `networkError`/`offline` fault modes (matches go's `deadLoopbackURL`).
pub fn dead_loopback_url() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    let addr = listener.local_addr().expect("local_addr");
    drop(listener);
    format!("http://{addr}")
}
