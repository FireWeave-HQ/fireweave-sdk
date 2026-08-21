//! Fireweave Rust conformance runner (`contracts/harness.md`).
//!
//! Loads the fixture suites under `contracts/`, invokes each against the
//! v1 control-points surface (`FireweaveClient.control_points` — there is
//! no OpenFeature bridge to reach for; ADR-0010 retired it), normalizes
//! results per the normative comparator, and emits a results JSON matching
//! `contracts/README.md`'s compatibility-report schema — the same shape
//! node/python/go/java's runners write.
//!
//! Suite -> execution backend, mirroring python's
//! `sdks/python/conformance/runner.py` module doc:
//!
//! - evaluation / context / lifecycle / security / (the one runnable
//!   extensions fixture): `InMemoryAdapter`, driving `FireweaveRuntime` +
//!   `FireweaveClient` directly. Two lifecycle/security fixtures whose
//!   `given.config` names a `host` route through `FireweaveRemoteAdapter`
//!   instead (this SDK's `FireweaveRuntime` carries no host/allowed-hosts
//!   concept of its own; only the remote adapter's own `initialize()`
//!   validates a host).
//! - faults: `FireweaveRemoteAdapter` with real HTTP against
//!   `conformance::fake_server` — a hermetic in-process loopback stub
//!   (see that module's doc comment for why: no `node` in the canonical
//!   dockerized `rust:1-slim` image, mirroring go/java's own
//!   environment-forced substitutions). `fault-stale-cache` runs on the
//!   in-memory adapter instead (cache staleness is provisioned directly).
//! - extensions: 13 of 14 fixtures target namespaces cut from v1
//!   (releases, exposures, signals, capabilities), classified data-driven
//!   from `when.operation`, and are reported `skipped-v1-out-of-scope`
//!   without executing. Only `ext-unsupported-capability-degrade`
//!   exercises real v1 surface and runs for real.
//!
//! Multi-case fixtures (`cases` array, `contracts/README.md`) run every
//! case against a fresh harness; the fixture passes only when all cases
//! pass.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use fireweave::{
    BackendAdapter, ContextLimits, Decision, ErrorKind, EvaluateOptions, EvaluationContext,
    FireweaveClient, FireweaveError, FireweaveRemoteAdapter, FireweaveRuntime, FlagResolution,
    FlagType, InMemoryAdapter, JsonValue, RegisterTargetOptions, RegisterTargetResult,
    RemoteAdapterConfig, RuntimeConfig, DEFAULT_RESERVED_ATTRIBUTE_KEYS,
};

use crate::fake_server::{dead_loopback_url, FakeServer, FaultMode};

const LANGUAGE: &str = "rust";
const SUITES: [&str; 6] = [
    "evaluation",
    "context",
    "lifecycle",
    "faults",
    "security",
    "extensions",
];

// ---------------------------------------------------------------------------
// v1-scope classification (contracts/harness.md "Extension fixtures — v1
// scope rule", ruling 2), DATA-DRIVEN from `when.operation` — see
// sdks/python/conformance/runner.py's CUT_OPERATION_NAMESPACE for the full
// rationale (identical here).

fn cut_operation_namespace(operation: &str) -> Option<&'static str> {
    match operation {
        "setContext" | "start" | "complete" | "fail" => Some("releases"),
        "recordExposure" | "flushExposures" => Some("exposures"),
        "emitSignal" => Some("signals"),
        "getCapabilities" => Some("capabilities"),
        // invokeCapability is deliberately absent: it is v1 surface, not cut.
        _ => None,
    }
}

/// Returns the cut namespace name when every operation this fixture
/// dispatches targets one, or `None` when the fixture genuinely exercises
/// v1 surface (today: only `ext-unsupported-capability-degrade`).
fn v1_out_of_scope_namespace(fixture: &JsonValue) -> Option<&'static str> {
    let operations: Vec<String> =
        if let Some(cases) = fixture.get("cases").and_then(JsonValue::as_array) {
            cases.iter().map(operation_of).collect()
        } else {
            vec![operation_of(fixture)]
        };
    let namespaces: Vec<Option<&'static str>> = operations
        .iter()
        .map(|op| cut_operation_namespace(op))
        .collect();
    if namespaces.iter().all(Option::is_some) {
        namespaces[0]
    } else {
        None
    }
}

fn operation_of(fixture_or_case: &JsonValue) -> String {
    fixture_or_case
        .get("when")
        .and_then(|w| w.get("operation"))
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .to_string()
}

// ---------------------------------------------------------------------------
// fixture -> SDK object construction

fn to_flag_type(raw: &str) -> FlagType {
    match raw {
        "integer" | "float" => FlagType::Number,
        other => other.parse().unwrap_or(FlagType::Boolean),
    }
}

fn context_from(ctx: Option<&JsonValue>) -> Option<EvaluationContext> {
    let ctx = ctx?;
    let targeting_key = ctx
        .get("targetingKey")
        .and_then(JsonValue::as_str)
        .map(str::to_string);
    let attributes = ctx
        .get("attributes")
        .and_then(JsonValue::as_object)
        .cloned()
        .unwrap_or_default();
    Some(EvaluationContext {
        targeting_key,
        attributes,
    })
}

/// `contracts/evaluation/eval-payload-attached.json`'s `when.options`
/// (task-10b item 5) -> [`EvaluateOptions`].
fn evaluate_options_from(options: Option<&JsonValue>) -> Option<EvaluateOptions> {
    let options = options?;
    Some(EvaluateOptions {
        include_payload: options
            .get("includePayload")
            .and_then(JsonValue::as_bool)
            .unwrap_or(false),
    })
}

fn limits_from(config: &JsonValue) -> ContextLimits {
    let limits = config.get("limits").cloned().unwrap_or_else(|| json!({}));
    let get = |key: &str, default: usize| {
        limits
            .get(key)
            .and_then(JsonValue::as_u64)
            .map(|v| v as usize)
            .unwrap_or(default)
    };
    ContextLimits {
        max_attribute_count: get("maxAttributeCount", 128),
        max_key_bytes: get("maxKeyBytes", 256),
        max_value_bytes: get("maxValueBytes", 4096),
        max_nesting_depth: get("maxNestingDepth", 6),
        max_serialized_bytes: get("maxSerializedContextBytes", 65536),
    }
}

fn decision_to_actual(decision: &Decision) -> serde_json::Map<String, JsonValue> {
    let mut out = serde_json::Map::new();
    out.insert("value".to_string(), decision.value.clone());
    out.insert(
        "variant".to_string(),
        decision
            .variant
            .clone()
            .map(JsonValue::String)
            .unwrap_or(JsonValue::Null),
    );
    out.insert(
        "reason".to_string(),
        JsonValue::String(decision.reason.clone()),
    );
    out.insert(
        "errorCode".to_string(),
        decision
            .error_code
            .clone()
            .map(JsonValue::String)
            .unwrap_or(JsonValue::Null),
    );
    out.insert(
        "errorMessage".to_string(),
        decision
            .error_message
            .clone()
            .map(JsonValue::String)
            .unwrap_or(JsonValue::Null),
    );
    out.insert(
        "flagMetadata".to_string(),
        JsonValue::Object(decision.flag_metadata.clone()),
    );
    out
}

// ---------------------------------------------------------------------------
// runner-owned adapter wrappers (given.fault applied to the in-memory
// backend for security-suite fixtures; resolve()-call counting for
// networkCalls assertions) — mirrors python's _FaultyAdapter/_CountingAdapter.

struct FaultyAdapter {
    kind: ErrorKind,
}

impl BackendAdapter for FaultyAdapter {
    fn initialize(&self) -> Result<(), FireweaveError> {
        Ok(())
    }
    fn resolve(
        &self,
        _flag_key: &str,
        _context: &EvaluationContext,
    ) -> Result<FlagResolution, FireweaveError> {
        Err(FireweaveError::new(self.kind))
    }
    fn shutdown(&self, _timeout_ms: u64) {}
}

/// Maps a fixture fault declaration to the [`FireweaveError`] it must
/// return (security-suite fixtures declare protocol faults but run on the
/// in-memory adapter — model them as a returned error of the equivalent
/// kind, mirroring node's `run.ts`).
fn fault_to_error_kind(fault: &JsonValue) -> ErrorKind {
    match fault.get("mode").and_then(JsonValue::as_str).unwrap_or("") {
        "httpStatus" => match fault
            .get("status")
            .and_then(JsonValue::as_u64)
            .unwrap_or(500)
        {
            401 => ErrorKind::Authentication,
            403 => ErrorKind::Authorization,
            429 => ErrorKind::RateLimited,
            _ => ErrorKind::BackendUnavailable,
        },
        "networkError" | "offline" => ErrorKind::Network,
        "timeout" => ErrorKind::Timeout,
        "invalidJson" | "malformedJson" | "truncated" => ErrorKind::MalformedResponse,
        _ => ErrorKind::Internal,
    }
}

struct CountingAdapter {
    inner: Box<dyn BackendAdapter>,
    count: Arc<AtomicUsize>,
}

impl BackendAdapter for CountingAdapter {
    fn initialize(&self) -> Result<(), FireweaveError> {
        self.inner.initialize()
    }
    fn resolve(
        &self,
        flag_key: &str,
        context: &EvaluationContext,
    ) -> Result<FlagResolution, FireweaveError> {
        self.count.fetch_add(1, Ordering::SeqCst);
        self.inner.resolve(flag_key, context)
    }
    fn shutdown(&self, timeout_ms: u64) {
        self.inner.shutdown(timeout_ms)
    }
    fn register_target(
        &self,
        targeting_key: &str,
        options: Option<&RegisterTargetOptions>,
    ) -> RegisterTargetResult {
        self.inner.register_target(targeting_key, options)
    }
}

fn provision_state(runtime: &FireweaveRuntime, state: Option<&str>) {
    match state {
        Some("READY") => {
            let _ = runtime.initialize();
        }
        Some("STALE") => {
            let _ = runtime.initialize();
            runtime.force_state(fireweave::LifecycleState::Stale);
        }
        Some("CLOSED") => {
            let _ = runtime.initialize();
            runtime.shutdown();
        }
        // NOT_READY / None: leave Uninitialized.
        _ => {}
    }
}

fn resolved_context_view(
    limits: &ContextLimits,
    reserved: &[String],
    require_targeting_key: bool,
    global_ctx: Option<&EvaluationContext>,
    client_ctx: Option<&EvaluationContext>,
    invocation_ctx: Option<&EvaluationContext>,
) -> JsonValue {
    let merged = fireweave::merge_contexts(&[global_ctx, client_ctx, invocation_ctx]);
    let reserved_keys: Vec<&str> = DEFAULT_RESERVED_ATTRIBUTE_KEYS
        .iter()
        .copied()
        .chain(reserved.iter().map(String::as_str))
        .collect();
    if fireweave::validate_context(&merged, limits, &reserved_keys, require_targeting_key).is_err()
    {
        return json!({});
    }
    let mut out = serde_json::Map::new();
    if let Some(tk) = &merged.targeting_key {
        out.insert("targetingKey".to_string(), JsonValue::String(tk.clone()));
    }
    let attrs: serde_json::Map<String, JsonValue> = merged
        .attributes
        .iter()
        .filter(|(k, _)| !k.starts_with('$'))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if !attrs.is_empty() {
        out.insert("attributes".to_string(), JsonValue::Object(attrs));
    }
    JsonValue::Object(out)
}

// ---------------------------------------------------------------------------
// per-suite executors

fn run_evaluate(fixture: &JsonValue) -> JsonValue {
    let empty = json!({});
    let given = fixture.get("given").unwrap_or(&empty);
    let when = fixture.get("when").unwrap_or(&empty);

    // Multi-domain lifecycle fixture support: independent runtime/client
    // per domain (no OpenFeature domain multiplexing to reach for post-
    // ADR-0010).
    if let Some(domains) = given.get("domains").and_then(JsonValue::as_object) {
        let requested = when.get("domain").and_then(JsonValue::as_str);
        let mut output = serde_json::Map::new();
        for (name, domain_given) in domains {
            let flags = domain_given
                .get("flags")
                .and_then(JsonValue::as_object)
                .cloned()
                .unwrap_or_default();
            let runtime = FireweaveRuntime::new(
                Box::new(InMemoryAdapter::new(flags)),
                RuntimeConfig::default(),
            );
            provision_state(
                &runtime,
                domain_given
                    .get("providerState")
                    .and_then(JsonValue::as_str),
            );
            if Some(name.as_str()) == requested {
                let client = FireweaveClient::new(Arc::new(runtime));
                let decision = client.control_points.evaluate(
                    when.get("flagKey")
                        .and_then(JsonValue::as_str)
                        .unwrap_or_default(),
                    to_flag_type(
                        when.get("flagType")
                            .and_then(JsonValue::as_str)
                            .unwrap_or("boolean"),
                    ),
                    when.get("defaultValue").cloned().unwrap_or(JsonValue::Null),
                    context_from(when.get("invocationContext")).as_ref(),
                    None,
                );
                output = decision_to_actual(&decision);
            }
        }
        return JsonValue::Object(output);
    }

    let config = given.get("config").cloned().unwrap_or_else(|| json!({}));
    let limits = limits_from(&config);
    let reserved: Vec<String> = config
        .get("reservedAttributeKeys")
        .and_then(JsonValue::as_array)
        .map(|a| {
            a.iter()
                .filter_map(JsonValue::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let require_targeting_key = config
        .get("requireTargetingKey")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);

    let flags = given
        .get("flags")
        .and_then(JsonValue::as_object)
        .cloned()
        .unwrap_or_default();
    let base_adapter: Box<dyn BackendAdapter> = match given.get("fault") {
        Some(fault)
            if fault
                .get("applyTo")
                .and_then(JsonValue::as_str)
                .unwrap_or("flags")
                == "flags" =>
        {
            Box::new(FaultyAdapter {
                kind: fault_to_error_kind(fault),
            })
        }
        _ => Box::new(InMemoryAdapter::new(flags)),
    };
    let resolve_calls = Arc::new(AtomicUsize::new(0));
    let counting = CountingAdapter {
        inner: base_adapter,
        count: resolve_calls.clone(),
    };

    let global_ctx = context_from(given.get("globalContext"));
    let runtime_config = RuntimeConfig {
        limits,
        reserved_attribute_keys: reserved.clone(),
        require_targeting_key,
        global_context: global_ctx.clone(),
        ..RuntimeConfig::default()
    };
    let runtime = Arc::new(FireweaveRuntime::new(Box::new(counting), runtime_config));
    let client = FireweaveClient::new(runtime.clone());
    let client_ctx = context_from(given.get("clientContext"));
    if let Some(cc) = client_ctx.clone() {
        client.set_context(Some(cc));
    }

    provision_state(
        &runtime,
        given.get("providerState").and_then(JsonValue::as_str),
    );

    let invocation_ctx = context_from(when.get("invocationContext"));
    let options = evaluate_options_from(when.get("options"));
    let decision = client.control_points.evaluate(
        when.get("flagKey")
            .and_then(JsonValue::as_str)
            .unwrap_or_default(),
        to_flag_type(
            when.get("flagType")
                .and_then(JsonValue::as_str)
                .unwrap_or("boolean"),
        ),
        when.get("defaultValue").cloned().unwrap_or(JsonValue::Null),
        invocation_ctx.as_ref(),
        options.as_ref(),
    );
    let mut actual = decision_to_actual(&decision);

    let expect = fixture.get("expect").cloned().unwrap_or_else(|| json!({}));
    if expect.get("contextSnapshotAfter").is_some() {
        let raw = when
            .get("invocationContext")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let mut snapshot = serde_json::Map::new();
        if let Some(tk) = raw.get("targetingKey").and_then(JsonValue::as_str) {
            snapshot.insert(
                "targetingKey".to_string(),
                JsonValue::String(tk.to_string()),
            );
        }
        if let Some(attrs) = raw.get("attributes").and_then(JsonValue::as_object) {
            if !attrs.is_empty() {
                snapshot.insert("attributes".to_string(), JsonValue::Object(attrs.clone()));
            }
        }
        actual.insert(
            "contextSnapshotAfter".to_string(),
            JsonValue::Object(snapshot),
        );
    }
    if expect.get("resolvedContext").is_some() {
        actual.insert(
            "resolvedContext".to_string(),
            resolved_context_view(
                &limits_from(&config),
                &reserved,
                require_targeting_key,
                global_ctx.as_ref(),
                client_ctx.as_ref(),
                invocation_ctx.as_ref(),
            ),
        );
    }
    if expect.get("networkCalls").is_some() {
        actual.insert(
            "networkCalls".to_string(),
            JsonValue::from(resolve_calls.load(Ordering::SeqCst)),
        );
    }
    JsonValue::Object(actual)
}

fn run_replace_provider(fixture: &JsonValue) -> JsonValue {
    let empty = json!({});
    let given = fixture.get("given").unwrap_or(&empty);
    let when = fixture.get("when").unwrap_or(&empty);

    let flags_a = given
        .get("flags")
        .and_then(JsonValue::as_object)
        .cloned()
        .unwrap_or_default();
    let runtime_a = FireweaveRuntime::new(
        Box::new(InMemoryAdapter::new(flags_a)),
        RuntimeConfig::default(),
    );
    let _ = runtime_a.initialize();
    runtime_a.shutdown(); // old provider retired before the replacement takes over

    let replacement = given
        .get("replacement")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let flags_b = replacement
        .get("flags")
        .and_then(JsonValue::as_object)
        .cloned()
        .unwrap_or_default();
    let runtime_b = Arc::new(FireweaveRuntime::new(
        Box::new(InMemoryAdapter::new(flags_b)),
        RuntimeConfig::default(),
    ));
    let _ = runtime_b.initialize();
    let client_b = FireweaveClient::new(runtime_b.clone());

    let then = when
        .get("thenEvaluate")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let decision = client_b.control_points.evaluate(
        then.get("flagKey")
            .and_then(JsonValue::as_str)
            .unwrap_or_default(),
        to_flag_type(
            then.get("flagType")
                .and_then(JsonValue::as_str)
                .unwrap_or("boolean"),
        ),
        then.get("defaultValue").cloned().unwrap_or(JsonValue::Null),
        context_from(then.get("invocationContext")).as_ref(),
        None,
    );
    let mut actual = decision_to_actual(&decision);
    actual.insert(
        "providerState".to_string(),
        JsonValue::String(runtime_b.state().wire_name().to_string()),
    );
    JsonValue::Object(actual)
}

fn run_initialize(fixture: &JsonValue) -> JsonValue {
    let empty = json!({});
    let given = fixture.get("given").unwrap_or(&empty);
    let config = given.get("config").cloned().unwrap_or_else(|| json!({}));
    let host = config.get("host").and_then(JsonValue::as_str);

    let runtime: FireweaveRuntime;
    let init_result: Result<(), FireweaveError>;
    if let Some(host) = host {
        // Host-allowlist-testing fixtures route through the remote
        // adapter: this SDK's FireweaveRuntime carries no host/allowed-
        // hosts concept of its own — only FireweaveRemoteAdapter's own
        // initialize() validates a host.
        let allowed_hosts = config
            .get("allowedHosts")
            .and_then(JsonValue::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(JsonValue::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            });
        let adapter = FireweaveRemoteAdapter::new(RemoteAdapterConfig {
            api_url: host.to_string(),
            api_key: config
                .get("projectApiKey")
                .and_then(JsonValue::as_str)
                .unwrap_or("")
                .to_string(),
            allowed_hosts,
            request_timeout_ms: 3000,
        });
        runtime = FireweaveRuntime::new(Box::new(adapter), RuntimeConfig::default());
        init_result = runtime.initialize();
    } else {
        let flags = given
            .get("flags")
            .and_then(JsonValue::as_object)
            .cloned()
            .unwrap_or_default();
        runtime = FireweaveRuntime::new(
            Box::new(InMemoryAdapter::new(flags)),
            RuntimeConfig::default(),
        );
        init_result = runtime.initialize();
    }

    let mut actual = serde_json::Map::new();
    actual.insert(
        "providerState".to_string(),
        JsonValue::String(runtime.state().wire_name().to_string()),
    );
    match init_result {
        Ok(()) => {
            actual.insert("errorCode".to_string(), JsonValue::Null);
            actual.insert("errorMessage".to_string(), JsonValue::Null);
        }
        Err(err) => {
            actual.insert(
                "errorCode".to_string(),
                JsonValue::String(err.openfeature_error_code().to_string()),
            );
            actual.insert(
                "errorMessage".to_string(),
                JsonValue::String(err.message.clone()),
            );
            if fixture
                .get("expect")
                .and_then(|e| e.get("errorKind"))
                .is_some()
            {
                actual.insert(
                    "errorKind".to_string(),
                    JsonValue::String(err.kind.as_str().to_string()),
                );
            }
        }
    }
    runtime.shutdown();
    JsonValue::Object(actual)
}

fn run_shutdown(fixture: &JsonValue) -> JsonValue {
    let empty = json!({});
    let given = fixture.get("given").unwrap_or(&empty);
    let flags = given
        .get("flags")
        .and_then(JsonValue::as_object)
        .cloned()
        .unwrap_or_default();
    let runtime = FireweaveRuntime::new(
        Box::new(InMemoryAdapter::new(flags)),
        RuntimeConfig::default(),
    );
    provision_state(
        &runtime,
        given.get("providerState").and_then(JsonValue::as_str),
    );
    runtime.shutdown();

    let mut actual = serde_json::Map::new();
    actual.insert(
        "providerState".to_string(),
        JsonValue::String(runtime.state().wire_name().to_string()),
    );
    actual.insert("errorCode".to_string(), JsonValue::Null);
    actual.insert("errorMessage".to_string(), JsonValue::Null);
    JsonValue::Object(actual)
}

/// Only `ext-unsupported-capability-degrade` reaches here (see
/// `v1_out_of_scope_namespace` above). Exercises
/// `FireweaveClient::invoke_capability`, present and un-cut in v1.
fn run_extension(fixture: &JsonValue) -> JsonValue {
    let empty = json!({});
    let given = fixture.get("given").unwrap_or(&empty);
    let when = fixture.get("when").unwrap_or(&empty);
    let flags = given
        .get("flags")
        .and_then(JsonValue::as_object)
        .cloned()
        .unwrap_or_default();
    let runtime = Arc::new(FireweaveRuntime::new(
        Box::new(InMemoryAdapter::new(flags)),
        RuntimeConfig::default(),
    ));
    let state = given
        .get("providerState")
        .and_then(JsonValue::as_str)
        .or(Some("READY"));
    provision_state(&runtime, state);
    let client = FireweaveClient::new(runtime);

    let operation = when
        .get("operation")
        .and_then(JsonValue::as_str)
        .unwrap_or("");
    if operation != "invokeCapability" {
        panic!("unsupported v1 extension operation {operation:?} (should have been classified skipped-v1-out-of-scope)");
    }
    let capability = when
        .get("capability")
        .and_then(JsonValue::as_str)
        .unwrap_or("");
    let result = client.invoke_capability(capability);

    let mut actual = serde_json::Map::new();
    actual.insert("ok".to_string(), JsonValue::Bool(result.ok));
    actual.insert(
        "errorCode".to_string(),
        if result.ok {
            JsonValue::Null
        } else {
            result
                .error_code
                .clone()
                .map(JsonValue::String)
                .unwrap_or(JsonValue::Null)
        },
    );
    actual.insert(
        "errorMessage".to_string(),
        if result.ok {
            JsonValue::Null
        } else {
            result
                .error_message
                .clone()
                .map(JsonValue::String)
                .unwrap_or(JsonValue::Null)
        },
    );
    actual.insert(
        "errorKind".to_string(),
        if result.ok {
            JsonValue::Null
        } else {
            result
                .error_kind
                .map(|k| JsonValue::String(k.as_str().to_string()))
                .unwrap_or(JsonValue::Null)
        },
    );
    if !result.ok && result.degraded {
        actual.insert("degraded".to_string(), JsonValue::Bool(true));
    }
    JsonValue::Object(actual)
}

// ---------------------------------------------------------------------------
// faults suite: real HTTP against the hermetic fake_server stub

fn run_fault(fixture: &JsonValue, fake_server: &FakeServer) -> JsonValue {
    let empty = json!({});
    let given = fixture.get("given").unwrap_or(&empty);
    let when = fixture.get("when").unwrap_or(&empty);

    // Stale-cache runs on the in-memory adapter (cache state provisioned directly).
    if fixture.get("id").and_then(JsonValue::as_str) == Some("fault-stale-cache") {
        return run_evaluate(fixture);
    }

    let fault = given
        .get("fault")
        .cloned()
        .unwrap_or_else(|| json!({"mode": "none"}));
    let mode = fault
        .get("mode")
        .and_then(JsonValue::as_str)
        .unwrap_or("none");

    let config = given.get("config").cloned().unwrap_or_else(|| json!({}));
    let timeout_ms = config
        .get("featureFlagsRequestTimeoutMs")
        .and_then(JsonValue::as_u64)
        .unwrap_or(3000);
    // The fixture's key is passed through verbatim rather than replaced
    // with a Fireweave-shaped one: sec-secrets-not-in-errors asserts that
    // no `phc_` substring reaches an error message, and substituting the
    // key would make that assertion pass trivially instead of exercising
    // redaction.
    let api_key = config
        .get("projectApiKey")
        .and_then(JsonValue::as_str)
        .unwrap_or("phc_TESTKEY0000000000000000000001")
        .to_string();

    let api_url = if mode == "networkError" || mode == "offline" {
        dead_loopback_url()
    } else {
        match mode {
            "httpStatus" => {
                let status = fault
                    .get("status")
                    .and_then(JsonValue::as_u64)
                    .unwrap_or(500) as u16;
                fake_server.set_fault(FaultMode::HttpStatus(status));
            }
            "invalidJson" => {
                let body = fault
                    .get("body")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("{not-json")
                    .to_string();
                fake_server.set_fault(FaultMode::InvalidJson(body));
            }
            "quotaLimited" => fake_server.set_fault(FaultMode::QuotaLimited),
            "delay" => {
                let delay_ms = fault
                    .get("delayMs")
                    .and_then(JsonValue::as_u64)
                    .unwrap_or(1000);
                fake_server.set_fault(FaultMode::Delay(Duration::from_millis(delay_ms)));
            }
            _ => fake_server.set_fault(FaultMode::Ok),
        }
        fake_server.url.clone()
    };

    let adapter = FireweaveRemoteAdapter::new(RemoteAdapterConfig {
        api_url,
        api_key,
        allowed_hosts: None,
        request_timeout_ms: timeout_ms,
    });
    let runtime = Arc::new(FireweaveRuntime::new(
        Box::new(adapter),
        RuntimeConfig::default(),
    ));
    let _ = runtime.initialize();
    let client = FireweaveClient::new(runtime.clone());
    let decision = client.control_points.evaluate(
        when.get("flagKey")
            .and_then(JsonValue::as_str)
            .unwrap_or_default(),
        to_flag_type(
            when.get("flagType")
                .and_then(JsonValue::as_str)
                .unwrap_or("boolean"),
        ),
        when.get("defaultValue").cloned().unwrap_or(JsonValue::Null),
        context_from(when.get("invocationContext")).as_ref(),
        None,
    );
    runtime.shutdown();
    JsonValue::Object(decision_to_actual(&decision))
}

fn dispatch(fixture: &JsonValue, fake_server: &FakeServer) -> JsonValue {
    if fixture.get("suite").and_then(JsonValue::as_str) == Some("faults") {
        return run_fault(fixture, fake_server);
    }
    match operation_of(fixture).as_str() {
        "evaluate" => run_evaluate(fixture),
        "initialize" => run_initialize(fixture),
        "shutdown" => run_shutdown(fixture),
        "replaceProvider" => run_replace_provider(fixture),
        _ => run_extension(fixture),
    }
}

// ---------------------------------------------------------------------------
// comparator (contracts/harness.md, normative)

const META_EXPECT_KEYS: [&str; 2] = [
    "errorMessageMustNotContain",
    "recordedMessageMustNotContain",
];

fn numbers_equal(a: &serde_json::Number, b: &serde_json::Number) -> bool {
    if let (Some(x), Some(y)) = (a.as_i64(), b.as_i64()) {
        return x == y;
    }
    if let (Some(x), Some(y)) = (a.as_u64(), b.as_u64()) {
        return x == y;
    }
    // Only reached when at least one side is a genuine float literal (no
    // exact integer representation), so no precision is lost that wasn't
    // already inherent — large-integer fixtures (e.g.
    // eval-int-beyond-safe-integer's 9007199254740993) are written WITHOUT
    // a decimal point and take the exact as_i64/as_u64 path above.
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

/// Deep-equality for JSON values (mirrors node/python's `deepEqual`/
/// `_deep_equal`): numbers compare by numeric value (not representation),
/// objects require an EXACT key set match (this is what pins vendor-
/// metadata gating — ruling 11 — as a failure when only one of
/// `fireweave.vendorFlagId`/`fireweave.reasonCode` leaks).
fn json_deep_eq(a: &JsonValue, b: &JsonValue) -> bool {
    match (a, b) {
        (JsonValue::Null, JsonValue::Null) => true,
        (JsonValue::Bool(x), JsonValue::Bool(y)) => x == y,
        (JsonValue::Number(x), JsonValue::Number(y)) => numbers_equal(x, y),
        (JsonValue::String(x), JsonValue::String(y)) => x == y,
        (JsonValue::Array(x), JsonValue::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y.iter()).all(|(xi, yi)| json_deep_eq(xi, yi))
        }
        (JsonValue::Object(x), JsonValue::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|yv| json_deep_eq(v, yv)))
        }
        _ => false,
    }
}

/// Compares `expect` vs `actual` per the normative comparator
/// (`contracts/README.md`): every declared expect key must match; missing
/// key -> fail. Mirrors node/python's `diff()`/`compare()` — this runner
/// does not fail on EXTRA actual keys beyond what a fixture declares
/// (harness.md's "Extra-key strictness note": that stricter behavior is
/// go-only and predates this task).
fn compare(expect: &JsonValue, actual: &JsonValue) -> Vec<String> {
    let mut failures = Vec::new();
    let Some(expect_obj) = expect.as_object() else {
        return failures;
    };
    for (key, expected) in expect_obj {
        if META_EXPECT_KEYS.contains(&key.as_str()) {
            continue;
        }
        let actual_value = actual.get(key).cloned().unwrap_or(JsonValue::Null);
        if expected.is_null() {
            if !actual_value.is_null() {
                failures.push(format!("{key}: expected null, got {actual_value}"));
            }
            continue;
        }
        if !json_deep_eq(&actual_value, expected) {
            failures.push(format!("{key}: expected {expected}, got {actual_value}"));
        }
    }
    if let Some(must_not_contain) = expect_obj
        .get("errorMessageMustNotContain")
        .and_then(JsonValue::as_array)
    {
        let message = actual
            .get("errorMessage")
            .and_then(JsonValue::as_str)
            .unwrap_or("");
        for needle in must_not_contain {
            if let Some(needle) = needle.as_str() {
                if message.contains(needle) {
                    failures.push(format!("errorMessage must not contain {needle:?}"));
                }
            }
        }
    }
    failures
}

// ---------------------------------------------------------------------------
// fixture execution

fn shallow_merge(base: &JsonValue, override_: Option<&JsonValue>) -> JsonValue {
    let mut merged = base.as_object().cloned().unwrap_or_default();
    if let Some(over) = override_.and_then(JsonValue::as_object) {
        for (k, v) in over {
            merged.insert(k.clone(), v.clone());
        }
    }
    JsonValue::Object(merged)
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic".to_string()
    }
}

/// `eval-numeric-coercion-int-float` requests `flagType: "integer"`
/// against a flag STORED as `"float"` and expects `TYPE_MISMATCH` — a
/// premise only meaningful when Integer/Float are distinct `FlagType`
/// members. v1 collapsed both to a single `Number` (`spec/control-
/// points.md`, `conformance/surface/control-points.surface.json`:
/// "number, NOT integer"), so requesting Number against a stored Number
/// value of `2.0` legitimately matches — this fixture's own premise is
/// unrepresentable for ANY v1-conformant language, not a rust-specific
/// gap. node/python/go/java each already declare this exact fixture
/// `skipped-with-documented-limitation`, all four with byte-for-byte the
/// same reasoning ("the same simplification node's own limitation
/// describes, applied uniformly by the v1 cut"). Because `contracts/` is
/// frozen and predates this SDK, the fixture carries no
/// `compatibility.rust`/`limitations.rust` entry to read — this constant
/// is a hand-classified extension of an ALREADY-UNANIMOUS, spec-level
/// classification to a fifth language, not a new judgment call. Recorded
/// as a numbered spec-ambiguity finding in task-12-report.md.
const V1_STRUCTURAL_LIMITATION_FIXTURE_IDS: [&str; 1] = ["eval-numeric-coercion-int-float"];

fn v1_structural_limitation(fixture_id: &str) -> Option<&'static str> {
    if V1_STRUCTURAL_LIMITATION_FIXTURE_IDS.contains(&fixture_id) {
        Some(
            "v1's FlagType has exactly four members (boolean/string/number/object), no integer/float \
             split (conformance/surface/control-points.surface.json: 'number, NOT integer') — the same \
             simplification node/python/go/java's own limitation describes for this fixture, applied \
             uniformly by the v1 cut. This fixture predates rust and carries no compatibility.rust \
             declaration to read (contracts/ is frozen), so this is a hand-classified extension of an \
             already-unanimous cross-language classification, not a new one.",
        )
    } else {
        None
    }
}

/// One compatibility-report row (`contracts/README.md`).
pub struct ReportRow {
    pub fixture_id: String,
    pub suite: String,
    pub status: String,
    pub limitation: Option<String>,
    pub message: Option<String>,
}

fn run_one(fixture: &JsonValue, fake_server: &FakeServer, label: Option<&str>) -> Vec<String> {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        dispatch(fixture, fake_server)
    }));
    let prefix = label.map(|l| format!("[{l}] ")).unwrap_or_default();
    match result {
        Ok(actual) => {
            let expect = fixture.get("expect").cloned().unwrap_or_else(|| json!({}));
            compare(&expect, &actual)
                .into_iter()
                .map(|f| format!("{prefix}{f}"))
                .collect()
        }
        Err(payload) => vec![format!(
            "{prefix}harness panic: {}",
            panic_message(&*payload)
        )],
    }
}

/// Runs one fixture; returns a report row matching `contracts/README.md`'s
/// compatibility-report schema.
pub fn run_fixture(fixture: &JsonValue, fake_server: &FakeServer) -> ReportRow {
    let fixture_id = fixture
        .get("id")
        .and_then(JsonValue::as_str)
        .unwrap_or("<unknown>")
        .to_string();
    let suite = fixture
        .get("suite")
        .and_then(JsonValue::as_str)
        .unwrap_or("<unknown>")
        .to_string();

    if let Some(limitation) = v1_structural_limitation(&fixture_id) {
        return ReportRow {
            fixture_id,
            suite,
            status: "skipped-with-documented-limitation".to_string(),
            limitation: Some(limitation.to_string()),
            message: None,
        };
    }

    // v1-scope rule (contracts/harness.md): extensions fixtures targeting
    // a cut namespace are reported skipped-v1-out-of-scope, never
    // executed, regardless of the fixture's own declared compatibility
    // (frozen "pass", authored pre-cut).
    if suite == "extensions" {
        if let Some(namespace) = v1_out_of_scope_namespace(fixture) {
            return ReportRow {
                fixture_id,
                suite,
                status: "skipped-v1-out-of-scope".to_string(),
                limitation: Some(format!("targets the {namespace} namespace, cut from the v1 control-points surface (ADR-0010)")),
                message: None,
            };
        }
    }

    // The 65 frozen fixtures predate this SDK, so none declare
    // `compatibility.rust` today — this branch exists for shape parity
    // with node/python/go/java's runners and forward-compatibility, not
    // because it is reachable against the current fixture set.
    if fixture
        .get("compatibility")
        .and_then(|c| c.get(LANGUAGE))
        .and_then(JsonValue::as_str)
        == Some("skipped-with-documented-limitation")
    {
        let limitation = fixture
            .get("limitations")
            .and_then(|l| l.get(LANGUAGE))
            .and_then(JsonValue::as_str)
            .unwrap_or("documented limitation")
            .to_string();
        return ReportRow {
            fixture_id,
            suite,
            status: "skipped-with-documented-limitation".to_string(),
            limitation: Some(limitation),
            message: None,
        };
    }

    let base_given = fixture.get("given").cloned().unwrap_or_else(|| json!({}));
    let mut failures: Vec<String> = Vec::new();

    if let Some(cases) = fixture.get("cases").and_then(JsonValue::as_array) {
        for case in cases {
            let name = case
                .get("name")
                .and_then(JsonValue::as_str)
                .unwrap_or("")
                .to_string();
            let mut case_fixture = fixture.clone();
            let merged_given = shallow_merge(&base_given, case.get("given"));
            case_fixture["given"] = merged_given;
            case_fixture["when"] = case.get("when").cloned().unwrap_or_else(|| json!({}));
            case_fixture["expect"] = case.get("expect").cloned().unwrap_or_else(|| json!({}));
            failures.extend(run_one(&case_fixture, fake_server, Some(&name)));
        }
    } else {
        failures.extend(run_one(fixture, fake_server, None));
    }

    let status = if failures.is_empty() { "pass" } else { "fail" };
    ReportRow {
        fixture_id,
        suite,
        status: status.to_string(),
        limitation: None,
        message: if failures.is_empty() {
            None
        } else {
            Some(failures.join(" | "))
        },
    }
}

pub fn load_fixtures(contracts_dir: &Path) -> Vec<JsonValue> {
    let mut fixtures = Vec::new();
    for suite in SUITES {
        let dir = contracts_dir.join(suite);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut paths: Vec<_> = entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == "json"))
            .collect();
        paths.sort();
        for path in paths {
            let contents = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
            let fixture: JsonValue = serde_json::from_str(&contents)
                .unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));
            fixtures.push(fixture);
        }
    }
    fixtures
}

/// Runs every fixture and returns the aggregated compatibility report
/// (`contracts/README.md` schema).
pub fn run_all(contracts_dir: &Path) -> JsonValue {
    let fixtures = load_fixtures(contracts_dir);
    let fake_server = FakeServer::start();

    let mut results = Vec::with_capacity(fixtures.len());
    let mut summary: BTreeMap<String, i64> = [
        "pass",
        "fail",
        "skipped-with-documented-limitation",
        "skipped-v1-out-of-scope",
    ]
    .into_iter()
    .map(|s| (s.to_string(), 0))
    .collect();

    let mut extensions_out_of_scope = 0;
    let mut extensions_runnable = 0;

    for fixture in &fixtures {
        let row = run_fixture(fixture, &fake_server);
        *summary.entry(row.status.clone()).or_insert(0) += 1;
        if row.suite == "extensions" {
            if row.status == "skipped-v1-out-of-scope" {
                extensions_out_of_scope += 1;
            } else {
                extensions_runnable += 1;
            }
        }
        results.push(json!({
            "fixtureId": row.fixture_id,
            "suite": row.suite,
            "language": LANGUAGE,
            "status": row.status,
            "limitation": row.limitation,
            "message": row.message,
        }));
    }

    // Sanity assertion (mirrors python/go's identical check): the
    // data-driven v1-scope classification must derive the exact same
    // 13-out/1-real split a hand-maintained fixture-ID list used to
    // encode elsewhere. If contracts/extensions/ ever gains or loses a
    // fixture, or a fixture's operation set changes, this fails loudly
    // instead of silently drifting.
    assert!(
        extensions_out_of_scope == 13 && extensions_runnable == 1,
        "v1-scope classification drifted: expected 13 skipped-v1-out-of-scope + 1 runnable extensions fixture, got {extensions_out_of_scope} + {extensions_runnable}"
    );

    json!({
        "schemaVersion": 1,
        "generatedAt": "EXCLUDED",
        "sdkCommit": "workspace",
        "contractsCommit": "workspace",
        "results": results,
        "summary": summary,
    })
}
