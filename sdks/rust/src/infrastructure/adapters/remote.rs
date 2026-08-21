//! Fireweave remote backend adapter — default production path.
//!
//! Real HTTP client (`ureq`) for fw-server `POST /v1/flags/evaluate` and
//! `POST /v1/targets/register`. Auth: `Authorization: Bearer <api_key>`.
//! Speaks only the vendor-neutral Fireweave remote protocol
//! (`spec/remote-protocol.md`) — no vendor SDK, key, or host ever enters
//! the application process; which backend fw-server forwards to is
//! fw-server's concern.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use crate::application::ports::{
    BackendAdapter, FlagResolution, RegisterTargetOptions, RegisterTargetResult,
};
use crate::domain::context::EvaluationContext;
use crate::domain::errors::{ErrorKind, FireweaveError};
use crate::domain::types::JsonValue;
use crate::infrastructure::hosts::{assert_host_allowed, extract_hostname};

const EVALUATE_PATH: &str = "/v1/flags/evaluate";
const REGISTER_TARGET_PATH: &str = "/v1/targets/register";

/// Construction-time configuration for [`FireweaveRemoteAdapter`].
pub struct RemoteAdapterConfig {
    pub api_url: String,
    pub api_key: String,
    /// `None` means the adapter-level fallback ([`default_allowed_hosts_for`]):
    /// the URL's own hostname plus loopback — NOT the canonical
    /// `infrastructure::hosts::DEFAULT_ALLOWED_HOSTS` list.
    /// `application::mode::init_fireweave` (the sanctioned entry point)
    /// already enforces the stricter canonical default before this adapter
    /// is ever constructed; this fallback only matters for direct adapter
    /// construction that bypasses `init_fireweave`.
    pub allowed_hosts: Option<Vec<String>>,
    pub request_timeout_ms: u64,
}

impl Default for RemoteAdapterConfig {
    fn default() -> Self {
        RemoteAdapterConfig {
            api_url: String::new(),
            api_key: String::new(),
            allowed_hosts: None,
            request_timeout_ms: 3000,
        }
    }
}

/// Adapter-level default when the caller supplies no `allowed_hosts`: the
/// URL's own hostname plus loopback.
fn default_allowed_hosts_for(api_url: &str) -> Option<Vec<String>> {
    let hostname = extract_hostname(api_url)?;
    Some(vec![
        hostname,
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "::1".to_string(),
    ])
}

/// Vendor-neutral remote adapter speaking the Fireweave wire protocol.
pub struct FireweaveRemoteAdapter {
    api_url: Mutex<String>,
    api_key: Mutex<String>,
    allowed_hosts: Option<Vec<String>>,
    request_timeout_ms: u64,
    ready: AtomicBool,
    closed: AtomicBool,
    agent: Mutex<Option<ureq::Agent>>,
}

impl FireweaveRemoteAdapter {
    pub fn new(config: RemoteAdapterConfig) -> Self {
        FireweaveRemoteAdapter {
            api_url: Mutex::new(config.api_url),
            api_key: Mutex::new(config.api_key),
            allowed_hosts: config.allowed_hosts,
            request_timeout_ms: config.request_timeout_ms,
            ready: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            agent: Mutex::new(None),
        }
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    fn request(&self, path: &str, body: &JsonValue) -> Result<JsonValue, FireweaveError> {
        let agent = {
            let guard = self.agent.lock().expect("agent lock poisoned");
            guard.clone()
        };
        let agent = agent.ok_or_else(|| FireweaveError::new(ErrorKind::NotReady))?;
        let url = format!(
            "{}{}",
            self.api_url.lock().expect("api_url lock poisoned"),
            path
        );
        let api_key = self.api_key.lock().expect("api_key lock poisoned").clone();
        let payload =
            serde_json::to_string(body).map_err(|_| FireweaveError::new(ErrorKind::Internal))?;

        let result = agent
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Authorization", &format!("Bearer {api_key}"))
            .send(payload.as_str());

        match result {
            Ok(mut response) => {
                let text = response
                    .body_mut()
                    .read_to_string()
                    .map_err(|_| FireweaveError::new(ErrorKind::MalformedResponse))?;
                let parsed: JsonValue = serde_json::from_str(&text)
                    .map_err(|_| FireweaveError::new(ErrorKind::MalformedResponse))?;
                if parsed.is_object() {
                    Ok(parsed)
                } else {
                    Err(FireweaveError::new(ErrorKind::MalformedResponse))
                }
            }
            Err(ureq::Error::StatusCode(401)) => {
                Err(FireweaveError::new(ErrorKind::Authentication))
            }
            Err(ureq::Error::StatusCode(403)) => Err(FireweaveError::new(ErrorKind::Authorization)),
            Err(ureq::Error::StatusCode(429)) => Err(FireweaveError::new(ErrorKind::RateLimited)),
            Err(ureq::Error::StatusCode(_)) => {
                Err(FireweaveError::new(ErrorKind::BackendUnavailable))
            }
            Err(ureq::Error::Timeout(_)) => Err(FireweaveError::new(ErrorKind::Timeout)),
            Err(_) => Err(FireweaveError::new(ErrorKind::Network)),
        }
    }
}

impl BackendAdapter for FireweaveRemoteAdapter {
    fn initialize(&self) -> Result<(), FireweaveError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(FireweaveError::new(ErrorKind::AlreadyClosed));
        }
        let mut api_url_guard = self.api_url.lock().expect("api_url lock poisoned");
        let api_key_guard = self.api_key.lock().expect("api_key lock poisoned");
        let trimmed_url = api_url_guard.trim_end_matches('/').to_string();
        if trimmed_url.is_empty() || api_key_guard.is_empty() {
            return Err(FireweaveError::configuration("invalid configuration", true));
        }
        let allow = match &self.allowed_hosts {
            Some(hosts) if !hosts.is_empty() => Some(hosts.clone()),
            _ => default_allowed_hosts_for(&trimmed_url),
        };
        assert_host_allowed(&trimmed_url, allow.as_deref(), true)?;
        *api_url_guard = trimmed_url;

        let timeout = Duration::from_millis(self.request_timeout_ms.max(1));
        let agent_config = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .build();
        *self.agent.lock().expect("agent lock poisoned") = Some(agent_config.into());
        self.ready.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn resolve(
        &self,
        flag_key: &str,
        context: &EvaluationContext,
    ) -> Result<FlagResolution, FireweaveError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(FireweaveError::new(ErrorKind::AlreadyClosed));
        }
        if !self.ready.load(Ordering::SeqCst) {
            return Err(FireweaveError::new(ErrorKind::NotReady));
        }
        let targeting_key = context.targeting_key.clone().unwrap_or_default();
        if targeting_key.is_empty() {
            return Err(FireweaveError::targeting_key_missing());
        }

        let mut body = serde_json::Map::new();
        body.insert("targetingKey".to_string(), JsonValue::String(targeting_key));
        body.insert(
            "flagKeys".to_string(),
            JsonValue::Array(vec![JsonValue::String(flag_key.to_string())]),
        );

        let mut attributes = serde_json::Map::new();
        let mut groups: Option<serde_json::Map<String, JsonValue>> = None;
        let mut group_properties: Option<serde_json::Map<String, JsonValue>> = None;
        for (k, v) in context.attributes.iter() {
            if (k == "groups" || k == "fireweave.groups") && v.is_object() {
                groups = v.as_object().cloned();
                continue;
            }
            if (k == "groupProperties" || k == "fireweave.groupProperties") && v.is_object() {
                group_properties = v.as_object().cloned();
                continue;
            }
            if k.starts_with('$') || k.starts_with("fireweave.") {
                continue;
            }
            attributes.insert(k.clone(), v.clone());
        }
        if !attributes.is_empty() {
            body.insert("attributes".to_string(), JsonValue::Object(attributes));
        }
        if let Some(g) = groups {
            body.insert("groups".to_string(), JsonValue::Object(g));
        }
        if let Some(gp) = group_properties {
            body.insert("groupProperties".to_string(), JsonValue::Object(gp));
        }

        let data = self.request(EVALUATE_PATH, &JsonValue::Object(body))?;
        let decisions = data
            .get("decisions")
            .and_then(JsonValue::as_array)
            .cloned()
            .unwrap_or_default();
        let quota_limited = data
            .get("quotaLimited")
            .and_then(JsonValue::as_bool)
            .unwrap_or(false);
        let item = decisions
            .iter()
            .find(|d| d.get("flagKey").and_then(JsonValue::as_str) == Some(flag_key))
            .filter(|item| item.get("found").and_then(JsonValue::as_bool) != Some(false));

        // key unknown to the backend -> ERROR/FlagNotFound
        // (spec/control-points.md return-discipline table) — deliberately
        // NOT matched: false (that path means the local-mode "no decision,
        // use the caller's default" seam, which does not apply to remote's
        // "unknown key" row).
        let item = match item {
            Some(item) => item,
            None => return Err(FireweaveError::flag_not_found(quota_limited)),
        };

        let meta = item.get("flagMetadata").and_then(JsonValue::as_object);
        Ok(FlagResolution {
            value: item.get("value").cloned().unwrap_or(JsonValue::Null),
            variant: item
                .get("variant")
                .and_then(JsonValue::as_str)
                .map(str::to_string),
            enabled: item
                .get("enabled")
                .and_then(JsonValue::as_bool)
                .unwrap_or(true),
            matched: true,
            version: meta
                .and_then(|m| m.get("fireweave.flagVersion"))
                .and_then(JsonValue::as_i64),
            vendor_flag_id: meta
                .and_then(|m| m.get("fireweave.vendorFlagId"))
                .and_then(JsonValue::as_i64),
            reason_code: meta
                .and_then(|m| m.get("fireweave.reasonCode"))
                .and_then(JsonValue::as_str)
                .map(str::to_string),
            condition_index: None,
            payload: item.get("payload").cloned().filter(|v| !v.is_null()),
            fireweave_reason: item
                .get("reason")
                .and_then(JsonValue::as_str)
                .map(str::to_string),
            from_cache: false,
            extra_metadata: Default::default(),
        })
    }

    fn shutdown(&self, _timeout_ms: u64) {
        self.closed.store(true, Ordering::SeqCst);
        self.ready.store(false, Ordering::SeqCst);
    }

    /// Never returns `Err` for transport failures: registration sits in
    /// login paths, and an analytics call must not break sign-in. Retried
    /// ONCE when the error taxonomy marks the failure retryable; a
    /// rejected payload or bad key is not retried, since it would be
    /// rejected identically.
    fn register_target(
        &self,
        targeting_key: &str,
        options: Option<&RegisterTargetOptions>,
    ) -> RegisterTargetResult {
        if self.closed.load(Ordering::SeqCst) {
            return RegisterTargetResult::failure(FireweaveError::new(ErrorKind::AlreadyClosed));
        }
        if !self.ready.load(Ordering::SeqCst) {
            return RegisterTargetResult::failure(FireweaveError::new(ErrorKind::NotReady));
        }
        if targeting_key.is_empty() {
            return RegisterTargetResult::failure(FireweaveError::targeting_key_missing());
        }

        let mut body = serde_json::Map::new();
        body.insert(
            "targetingKey".to_string(),
            JsonValue::String(targeting_key.to_string()),
        );
        if let Some(opts) = options {
            if let Some(kind) = opts.kind {
                body.insert(
                    "kind".to_string(),
                    JsonValue::String(kind.as_str().to_string()),
                );
            }
            if let Some(env) = &opts.environment {
                body.insert("environment".to_string(), JsonValue::String(env.clone()));
            }
            if let Some(props) = &opts.properties {
                if !props.is_empty() {
                    body.insert("properties".to_string(), JsonValue::Object(props.clone()));
                }
            }
        }

        let mut last_error: Option<FireweaveError> = None;
        for _attempt in 0..2 {
            match self.request(REGISTER_TARGET_PATH, &JsonValue::Object(body.clone())) {
                Ok(_) => return RegisterTargetResult::success(),
                Err(err) => {
                    let retryable = err.retryable();
                    last_error = Some(err);
                    if !retryable {
                        break;
                    }
                }
            }
        }
        RegisterTargetResult::failure(
            last_error.unwrap_or_else(|| FireweaveError::new(ErrorKind::Internal)),
        )
    }
}
