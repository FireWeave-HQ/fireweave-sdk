//! `FireweaveLocalAdapter` — the DEV substrate for a scaffolded harness.
//!
//! Counterpart to `infrastructure::adapters::remote::FireweaveRemoteAdapter`:
//! prod evaluates control points against fw-server; dev evaluates them
//! here, in-process, with no network and no credentials. Because it
//! satisfies the same `BackendAdapter` port, the dev branch of a harness
//! runs through the same `FireweaveRuntime` as prod — inheriting identical
//! lifecycle gating and context canonicalization.
//!
//! Resolution policy is deliberately minimal:
//!
//! - a key present in the seeded map resolves to its mapped value with
//!   reason `STATIC` — the only supported way to turn a control point ON
//!   (or force it OFF) on a laptop;
//! - every other key MISSES (`matched: false`), which the runtime turns
//!   into the caller's own default with reason `DEFAULT` — not an error
//!   (`spec/modes.md` "Behaviour per mode": local's unknown-key row is
//!   deliberately `default`/`DEFAULT`, unlike remote's
//!   `default`/`ERROR`/`FlagNotFound`).

use std::collections::HashMap;
use std::sync::{Mutex, RwLock};

use crate::application::ports::{
    BackendAdapter, FlagResolution, RegisterTargetOptions, RegisterTargetResult,
};
use crate::domain::context::EvaluationContext;
use crate::domain::errors::FireweaveError;
use crate::domain::target::TargetKind;
use crate::domain::types::JsonValue;

/// A target recorded by [`FireweaveLocalAdapter::register_target`].
#[derive(Debug, Clone)]
pub struct LocalRegisteredTarget {
    pub targeting_key: String,
    pub kind: TargetKind,
    pub properties: serde_json::Map<String, JsonValue>,
    pub environment: Option<String>,
}

/// Sink for the `[fireweave:local]` `registerTarget` trace line.
/// Named alias so `Option<LogSink>` stays a plain type clippy won't flag
/// as overly complex.
pub type LogSink = Box<dyn Fn(&str) + Send + Sync>;

/// In-process boolean overrides for local development.
pub struct FireweaveLocalAdapter {
    dev_flags: HashMap<String, bool>,
    /// Sink for the "[fireweave:local]" `registerTarget` trace. Defaults to
    /// `eprintln!`. Injectable so tests assert the call without capturing
    /// stdout, and so a host that owns its logging can route it.
    log: LogSink,
    targets: RwLock<HashMap<String, LocalRegisteredTarget>>,
    closed: Mutex<bool>,
}

impl FireweaveLocalAdapter {
    pub fn new(dev_flags: HashMap<String, bool>, log: Option<LogSink>) -> Self {
        FireweaveLocalAdapter {
            dev_flags,
            log: log.unwrap_or_else(|| Box::new(|message: &str| eprintln!("{message}"))),
            targets: RwLock::new(HashMap::new()),
            closed: Mutex::new(false),
        }
    }

    /// Targets recorded this process, for assertions and dev inspection.
    pub fn registered_targets(&self) -> Vec<LocalRegisteredTarget> {
        self.targets
            .read()
            .expect("targets lock poisoned")
            .values()
            .cloned()
            .collect()
    }

    pub fn is_closed(&self) -> bool {
        *self.closed.lock().expect("closed lock poisoned")
    }
}

impl BackendAdapter for FireweaveLocalAdapter {
    fn initialize(&self) -> Result<(), FireweaveError> {
        *self.closed.lock().expect("closed lock poisoned") = false;
        Ok(())
    }

    /// A seeded-map hit reports `enabled: true` alongside reason `STATIC`.
    /// Reporting `enabled: false` for an override of `false` would make the
    /// runtime label the decision `DISABLED` — "the control point exists
    /// but is switched off upstream" — not what a local override
    /// expresses.
    ///
    /// A miss returns `matched: false` — the strict, typed seam
    /// `FireweaveRuntime::decision_from_resolution` reads to return the
    /// caller's default with reason `DEFAULT` instead of falling through
    /// to the generic FlagNotFound/ERROR path. This adapter never returns
    /// `Err` on a miss — that would be indistinguishable, from the
    /// runtime's perspective, from a genuine backend failure, and would
    /// produce the wrong (ERROR) reason.
    fn resolve(
        &self,
        flag_key: &str,
        _context: &EvaluationContext,
    ) -> Result<FlagResolution, FireweaveError> {
        match self.dev_flags.get(flag_key) {
            None => Ok(FlagResolution::miss()),
            Some(&override_value) => Ok(FlagResolution {
                value: JsonValue::Bool(override_value),
                variant: Some(if override_value {
                    "on".to_string()
                } else {
                    "off".to_string()
                }),
                enabled: true,
                matched: true,
                fireweave_reason: Some("STATIC".to_string()),
                ..Default::default()
            }),
        }
    }

    /// Records the target in-process and traces it, rather than reporting
    /// `UnsupportedCapability` (`spec/modes.md` "registerTarget in local
    /// mode").
    ///
    /// The failure being guarded against is a developer believing their
    /// targeting works because nothing objected. A recorded target plus an
    /// explicit `[fireweave:local]` line preserves that guarantee: nothing
    /// is silent, and local dev can exercise targeting rules offline
    /// instead of only in production.
    ///
    /// No network call is made and nothing reaches fw-server.
    fn register_target(
        &self,
        targeting_key: &str,
        options: Option<&RegisterTargetOptions>,
    ) -> RegisterTargetResult {
        let kind = options.and_then(|o| o.kind).unwrap_or_default();
        let properties = options
            .and_then(|o| o.properties.clone())
            .unwrap_or_default();
        let environment = options.and_then(|o| o.environment.clone());

        let target = LocalRegisteredTarget {
            targeting_key: targeting_key.to_string(),
            kind,
            properties: properties.clone(),
            environment,
        };
        self.targets
            .write()
            .expect("targets lock poisoned")
            .insert(targeting_key.to_string(), target);

        let properties_json = serde_json::to_string(&JsonValue::Object(properties))
            .unwrap_or_else(|_| "{}".to_string());
        (self.log)(&format!(
            "[fireweave:local] registerTarget {kind} {targeting_key} {properties_json} — recorded in-process, NOT sent to fw-server"
        ));

        RegisterTargetResult::success()
    }

    fn shutdown(&self, _timeout_ms: u64) {
        *self.closed.lock().expect("closed lock poisoned") = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn seeded_flag_resolves_static() {
        let mut flags = HashMap::new();
        flags.insert("on-flag".to_string(), true);
        let adapter = FireweaveLocalAdapter::new(flags, None);
        let ctx = EvaluationContext::new();
        let resolution = adapter.resolve("on-flag", &ctx).unwrap();
        assert!(resolution.matched);
        assert_eq!(resolution.value, JsonValue::Bool(true));
        assert_eq!(resolution.fireweave_reason.as_deref(), Some("STATIC"));
    }

    #[test]
    fn unseeded_flag_misses() {
        let adapter = FireweaveLocalAdapter::new(HashMap::new(), None);
        let resolution = adapter
            .resolve("absent", &EvaluationContext::new())
            .unwrap();
        assert!(!resolution.matched);
    }

    #[test]
    fn register_target_records_and_traces() {
        let traced: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = traced.clone();
        let adapter = FireweaveLocalAdapter::new(
            HashMap::new(),
            Some(Box::new(move |line: &str| {
                sink.lock().unwrap().push(line.to_string())
            })),
        );
        let result = adapter.register_target("user-1", None);
        assert!(result.ok);
        assert_eq!(adapter.registered_targets().len(), 1);
        let lines = traced.lock().unwrap();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].starts_with("[fireweave:local]"));
        assert!(lines[0].contains("NOT sent to fw-server"));
    }
}
