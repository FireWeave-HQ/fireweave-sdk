//! [`start`] and the process-wide singleton behind the module-level facade
//! (node: `src/start/state.ts`, go: `fw/state.go` + `fw/fw.go`).
//!
//! The start profile keeps ONE permanent [`FireweaveClient`] for the life of
//! the process, built on first use with no env reads and no I/O. Its runtime
//! sits on a forwarding adapter, so a `&'static` reference taken before
//! `start` (in a struct, a lazily built service) keeps working after it,
//! across [`shutdown`] and a later `start`. `start` resolves the config,
//! builds the real client with the unchanged core [`init_fireweave`] (so the
//! core validation table still runs), and points the forwarder at it.
//!
//! A read before any `start` starts FireWeave from the environment alone,
//! once, synchronously on that read. `init_fireweave` does no network I/O,
//! so this never blocks on the network.
//!
//! Locking: one `Mutex` guards the singleton. It is never held while a log
//! line is written or while a read runs against the started client, so a log
//! sink that calls back into this module cannot deadlock, and reads on many
//! threads run concurrently.

use std::collections::{BTreeMap, BTreeSet};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};

use crate::{
    init_fireweave, BackendAdapter, ControlPointsNamespace, ErrorKind, EvaluationContext,
    FireweaveClient, FireweaveError, FireweaveRuntime, FlagResolution, InitOptions, JsonValue,
    LifecycleState, Mode, RegisterTargetOptions, RegisterTargetResult, RuntimeConfig, TargetKind,
};

use super::channel::{sdk_channel, sdk_version, Channel};
use super::env::{lookup_from, process_hostname, Lookup};
use super::instance::{derive_instance_key, SOURCE_RANDOM};
use super::names::{ENV_INSTANCE_ID, ENV_KEY, FLAGS_FILE, OPT_INSTANCE_ID};
use super::options::{LogFn, StartOptions};
use super::resolve::{config_error, resolve, BuildInfo, Resolved, MODE_SOURCE_ENVIRONMENT};

/// Where the singleton is in its life.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StartState {
    /// Nothing has started yet (a read would start from the environment).
    Unstarted,
    Ready,
    /// The last start failed; reads serve their defaults.
    Failed,
    /// [`shutdown`] ran; reads serve their defaults until a new [`start`].
    Shutdown,
}

impl StartState {
    pub fn as_str(&self) -> &'static str {
        match self {
            StartState::Unstarted => "unstarted",
            StartState::Ready => "ready",
            StartState::Failed => "failed",
            StartState::Shutdown => "shutdown",
        }
    }
}

impl std::fmt::Display for StartState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// What makes two starts "the same". Flags count in local mode only: remote
/// ignores them, so an implicit env-only start followed by
/// `start(StartOptions { flags, .. })` under a key is not a conflict. Holds
/// the key to compare it; no `Debug`, and `differs` names fields only.
#[derive(Clone, PartialEq)]
struct Signature {
    mode: Mode,
    url: Option<String>,
    key: Option<String>,
    allowed_hosts: Option<Vec<String>>,
    instance_id: Option<String>,
    flags: Option<BTreeMap<String, bool>>,
}

fn trimmed_option(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

impl Signature {
    fn of(r: &Resolved, instance_id: Option<&str>) -> Self {
        Signature {
            mode: r.mode,
            url: r.url.clone(),
            key: r.key.clone(),
            allowed_hosts: r.allowed_hosts.clone(),
            instance_id: trimmed_option(instance_id),
            flags: (r.mode == Mode::Local).then(|| r.flags.local_values()),
        }
    }

    /// The names of the fields that differ, never their values.
    fn differs(&self, other: &Signature) -> Vec<&'static str> {
        let mut out = Vec::new();
        let mut add = |changed: bool, name: &'static str| {
            if changed {
                out.push(name);
            }
        };
        add(self.mode != other.mode, "mode");
        add(self.url != other.url, "url");
        add(self.key != other.key, "key");
        add(self.allowed_hosts != other.allowed_hosts, "allowed hosts");
        add(self.instance_id != other.instance_id, "instance id");
        add(self.flags != other.flags, "flags");
        out
    }
}

struct Singleton {
    state: StartState,
    /// The running client came from an implicit start.
    implicit: bool,
    /// Reads do not start implicitly again.
    implicit_tried: bool,
    resolved: Option<Resolved>,
    sig: Option<Signature>,
    client: Option<Arc<FireweaveClient>>,
    err: Option<FireweaveError>,
    /// The started configuration's env lookup (for `instance_key`).
    lookup: Option<Lookup>,

    instance_option: Option<String>,
    instance_key: Option<String>,

    log: Option<LogFn>,
    warned: BTreeSet<String>,
}

impl Singleton {
    const fn new() -> Self {
        Singleton {
            state: StartState::Unstarted,
            implicit: false,
            implicit_tried: false,
            resolved: None,
            sig: None,
            client: None,
            err: None,
            lookup: None,
            instance_option: None,
            instance_key: None,
            log: None,
            warned: BTreeSet::new(),
        }
    }

    /// Appends `line` unless this process already logged it.
    fn warn_once(&mut self, lines: &mut Vec<String>, line: String) {
        if self.warned.insert(line.clone()) {
            lines.push(line);
        }
    }

    /// Forgets a failed or shut-down start, keeping the warned set, the log
    /// sink and the instance key (it identifies the process, so a key handed
    /// out before a failed or shut-down start stays the same after it).
    fn fresh_run(&mut self) {
        self.state = StartState::Unstarted;
        self.implicit = false;
        self.implicit_tried = false;
        self.resolved = None;
        self.sig = None;
        self.client = None;
        self.err = None;
        self.lookup = None;
    }

    /// `start`'s body. Returns the lines to log once the lock is released.
    fn start_locked(
        &mut self,
        options: StartOptions,
        implicit: bool,
    ) -> (Vec<String>, Result<(), FireweaveError>) {
        let mut lines = Vec::new();
        if matches!(self.state, StartState::Failed | StartState::Shutdown) {
            self.fresh_run();
        }

        let lookup = lookup_from(options.env.as_ref());
        let build = BuildInfo {
            version: sdk_version().to_string(),
            channel: sdk_channel(),
        };
        let r = match resolve(&options, &*lookup, &build) {
            Ok(r) => r,
            Err(err) => {
                if self.state == StartState::Ready {
                    // A bad second start never takes down the running client.
                    return (lines, Err(err));
                }
                self.state = StartState::Failed;
                self.err = Some(err.clone());
                self.implicit_tried = true;
                if implicit {
                    self.warn_once(
                        &mut lines,
                        format!(
                            "[fireweave] {} (FireWeave was not started; reads serve their defaults.)",
                            err.message
                        ),
                    );
                }
                return (lines, Err(err));
            }
        };
        let sig = Signature::of(&r, options.instance_id.as_deref());

        if self.state == StartState::Ready {
            let diff = match &self.sig {
                Some(current) => current.differs(&sig),
                None => Vec::new(),
            };
            if diff.is_empty() {
                return (lines, Ok(()));
            }
            let fields = diff.join(", ");
            let err = if self.implicit {
                config_error(format!(
                    "A control point was read before fireweave::start::start ran, so FireWeave started from the environment alone; this start differs in {fields}. Call start first in main, before anything reads a control point."
                ))
            } else {
                config_error(format!(
                    "fireweave::start::start was already called with a different configuration ({fields}). Call start once, from main."
                ))
            };
            return (lines, Err(err));
        }

        if let Some(id) = trimmed_option(options.instance_id.as_deref()) {
            if self.instance_key.as_ref().is_some_and(|k| *k != id) {
                return (
                    lines,
                    Err(config_error(format!(
                        "{OPT_INSTANCE_ID} differs from the instance_key() already handed out. Pass instance_id on the first start."
                    ))),
                );
            }
        }

        // Only a start that actually begins sets the log sink: an identical
        // second start is a no-op and a conflicting one fails, and neither
        // may swap it.
        if !implicit {
            if let Some(log) = &options.log {
                self.log = Some(Arc::clone(log));
            }
        }

        let client = match init_fireweave(init_options(&r)) {
            Ok(client) => client,
            Err(err) => {
                self.state = StartState::Failed;
                self.err = Some(err.clone());
                self.implicit_tried = true;
                self.warn_once(
                    &mut lines,
                    format!(
                        "[fireweave] start failed: {}. Reads serve their defaults.",
                        err.message
                    ),
                );
                return (lines, Err(err));
            }
        };

        for w in &r.warnings {
            self.warn_once(&mut lines, w.clone());
        }
        if r.mode == Mode::Local {
            lines.push(local_line(&r));
        }
        if let Some(id) = trimmed_option(options.instance_id.as_deref()) {
            self.instance_option = Some(id);
        }
        self.state = StartState::Ready;
        self.implicit = implicit;
        self.implicit_tried = true;
        self.resolved = Some(r);
        self.sig = Some(sig);
        self.client = Some(Arc::new(client));
        self.err = None;
        self.lookup = Some(lookup);
        (lines, Ok(()))
    }
}

static SINGLETON: Mutex<Singleton> = Mutex::new(Singleton::new());

/// The singleton, recovering from a poisoned lock: no read may panic because
/// some other thread did.
fn lock() -> MutexGuard<'static, Singleton> {
    SINGLETON.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Writes lines to the sink (default: standard error). A panicking sink
/// never reaches the caller.
fn emit(log: Option<LogFn>, lines: Vec<String>) {
    for line in lines {
        let _ = catch_unwind(AssertUnwindSafe(|| match &log {
            Some(sink) => sink(&line),
            None => eprintln!("{line}"),
        }));
    }
}

/// Routes the core local adapter's `[fireweave:local]` trace through the
/// current sink.
fn route_line(line: &str) {
    let log = lock().log.clone();
    emit(log, vec![line.to_string()]);
}

fn local_line(r: &Resolved) -> String {
    let why = if r.mode_source == MODE_SOURCE_ENVIRONMENT {
        format!(
            "no {ENV_KEY}; environment {:?} from {}",
            r.environment.as_deref().unwrap_or_default(),
            r.environment_source.as_deref().unwrap_or_default()
        )
    } else {
        "StartOptions.mode Local".to_string()
    };
    let n = r.flags.len();
    let noun = if n == 1 { "flag" } else { "flags" };
    format!("[fireweave:local] Local mode ({why}). Serving {n} {noun} from your flags; nothing is sent to fw-server.")
}

fn init_options(r: &Resolved) -> InitOptions {
    match r.mode {
        Mode::Local => {
            InitOptions::local_with_control_points(r.flags.local_seeds()).with_log(route_line)
        }
        Mode::Remote => {
            let options = InitOptions::remote(
                r.key.clone().unwrap_or_default(),
                r.url.clone().unwrap_or_default(),
            );
            match &r.allowed_hosts {
                Some(hosts) => options.with_allowed_hosts(hosts.clone()),
                None => options,
            }
        }
    }
}

/// Starts FireWeave for this process. Call it once, first thing in `main`,
/// after the app's own config loading (and any `.env` loader).
///
/// **Mode rule.** `StartOptions::mode` wins (`Local` ignores any key, with
/// one warning; `Remote` without a key is an error). Otherwise a key
/// (`StartOptions::key`, `FIREWEAVE_KEY`) means remote; no key and an
/// environment name (`StartOptions::environment`, `FIREWEAVE_ENV`,
/// `APP_ENV`) of `development`, `dev`, `local` or `test` means local;
/// anything else, including no environment name at all, is a
/// `Configuration` error naming `FIREWEAVE_KEY`. A deploy that forgot its
/// key fails here instead of silently serving defaults.
///
/// `start` is synchronous and does no network I/O. A second call with the
/// same configuration is a no-op `Ok`; a different one returns a
/// `Configuration` error and leaves the running client alone. Every error is
/// a core [`FireweaveError`] (kind `Configuration`, `PROVIDER_FATAL`) naming
/// the option or variable at fault, never a key.
///
/// ```
/// use fireweave::start::{define_flags, env_map, start, Flag, StartOptions};
/// # fireweave::start::reset_for_tests();
///
/// start(StartOptions {
///     flags: define_flags([("new-checkout", Flag::local(true))]),
///     env: Some(env_map([("FIREWEAVE_ENV", "development")])),
///     log: Some(std::sync::Arc::new(|_line: &str| {})),
///     ..Default::default()
/// })?;
/// assert!(fireweave::start::control_points().get_boolean_value("new-checkout", false, None));
/// # fireweave::start::reset_for_tests();
/// # Ok::<(), fireweave::FireweaveError>(())
/// ```
pub fn start(options: StartOptions) -> Result<(), FireweaveError> {
    let (lines, result, log) = {
        let mut st = lock();
        let (lines, result) = st.start_locked(options, false);
        (lines, result, st.log.clone())
    };
    emit(log, lines);
    result
}

/// The running client for one read or registration, starting FireWeave from
/// the environment if nothing has started it yet. On failure, the error a
/// read reports instead.
fn acquire(flag_key: Option<&str>) -> Result<Arc<FireweaveClient>, FireweaveError> {
    let (result, lines, log) = {
        let mut st = lock();
        let mut lines = Vec::new();
        if st.state == StartState::Unstarted && !st.implicit_tried {
            let (implicit_lines, _) = st.start_locked(StartOptions::default(), true);
            lines = implicit_lines;
        }
        let result = match st.state {
            StartState::Ready => {
                if let Some(key) = flag_key {
                    let missing = st
                        .resolved
                        .as_ref()
                        .is_some_and(|r| r.mode == Mode::Local && !r.flags.contains_key(key));
                    if missing {
                        st.warn_once(
                            &mut lines,
                            format!("[fireweave:local] {key:?} is not in your flags ({FLAGS_FILE}), so it gets its default. Add it there to try it locally."),
                        );
                    }
                }
                st.client
                    .clone()
                    .ok_or_else(|| FireweaveError::new(ErrorKind::NotReady))
            }
            StartState::Shutdown => Err(FireweaveError::new(ErrorKind::AlreadyClosed)),
            StartState::Unstarted | StartState::Failed => {
                Err(st.err.clone().unwrap_or_else(|| {
                    FireweaveError::with_message(ErrorKind::NotReady, "FireWeave was not started.")
                }))
            }
        };
        (result, lines, st.log.clone())
    };
    emit(log, lines);
    result
}

/// The permanent client's adapter: it hands each call to the client the
/// latest [`start`] built. Reads that cannot reach one degrade to the
/// caller's default with the start error, exactly as a core read degrades.
///
/// The permanent runtime has already validated the key, the default and the
/// context, with the same `RuntimeConfig::default()` `init_fireweave` uses,
/// so `resolve` goes straight to the started client's adapter; the decision
/// is then built by the core runtime as usual.
struct Forwarder;

impl BackendAdapter for Forwarder {
    fn initialize(&self) -> Result<(), FireweaveError> {
        Ok(())
    }

    fn resolve(
        &self,
        flag_key: &str,
        context: &EvaluationContext,
    ) -> Result<FlagResolution, FireweaveError> {
        let client = acquire(Some(flag_key))?;
        let runtime = client.runtime();
        match runtime.state() {
            LifecycleState::Ready | LifecycleState::Stale => {
                runtime.adapter().resolve(flag_key, context)
            }
            LifecycleState::Shutdown => Err(FireweaveError::new(ErrorKind::AlreadyClosed)),
            _ => Err(FireweaveError::new(ErrorKind::NotReady)),
        }
    }

    /// Never shuts anything: [`shutdown`] shuts the started client, never
    /// the permanent one.
    fn shutdown(&self, _timeout_ms: u64) {}

    fn register_target(
        &self,
        targeting_key: &str,
        options: Option<&RegisterTargetOptions>,
    ) -> RegisterTargetResult {
        match acquire(None) {
            Ok(client) => client.register_target(targeting_key, options),
            Err(err) => RegisterTargetResult::failure(err),
        }
    }
}

static PERMANENT: OnceLock<FireweaveClient> = OnceLock::new();

/// The one [`FireweaveClient`] for this process: the same reference before
/// [`start`], after it, and across [`shutdown`] and a later `start`. Use it
/// for dependency injection (`&'static FireweaveClient`) and anything the
/// module functions do not cover. Its reads behave like
/// [`control_points`]'.
///
/// Shut down with [`shutdown`], never `client().shutdown()`, which would
/// close this permanent handle for the rest of the process.
pub fn client() -> &'static FireweaveClient {
    PERMANENT.get_or_init(|| {
        let runtime = Arc::new(FireweaveRuntime::new(
            Box::new(Forwarder),
            RuntimeConfig::default(),
        ));
        // Forwarder::initialize does nothing and never fails.
        let _ = runtime.initialize();
        FireweaveClient::new(runtime)
    })
}

/// The core's control point namespace on [`client`]: the same nine read
/// methods with the same signatures (`evaluate`, `get_boolean_value`,
/// `get_string_value`, `get_number_value`, `get_object_value` and the four
/// `*_details`).
///
/// ```
/// use fireweave::EvaluationContext;
/// # fireweave::start::reset_for_tests();
/// # fireweave::start::start(fireweave::start::StartOptions {
/// #     mode: Some(fireweave::Mode::Local),
/// #     log: Some(std::sync::Arc::new(|_line: &str| {})),
/// #     ..Default::default()
/// # }).unwrap();
///
/// let ctx = EvaluationContext::new().with_targeting_key("user-1");
/// // @fireweave-controlpoint new-checkout
/// if fireweave::start::control_points().get_boolean_value("new-checkout", false, Some(&ctx)) {
///     // new path
/// }
/// # fireweave::start::reset_for_tests();
/// ```
///
/// A read before any [`start`] starts FireWeave from the environment alone
/// (once). Reads never panic and never fail: before a successful start they
/// return the caller's default, and the `*_details` forms an `ERROR`
/// [`crate::Decision`] carrying the start error.
pub fn control_points() -> &'static ControlPointsNamespace {
    &client().control_points
}

/// Registers durable targeting facts for a user at sign-in (the core's
/// `register_target`, kind `user`). Returns the core error when the target
/// was not registered; the caller logs it and carries on. Never panics. A
/// blank targeting key is `InvalidContext` in both modes.
///
/// In remote mode it is one blocking POST, retried once on a transient
/// failure, so it can take two request timeouts when fw-server hangs; call
/// it off an async executor's threads (`spawn_blocking`). In local mode the
/// target is recorded in-process and traced through the log sink.
///
/// ```
/// # fireweave::start::reset_for_tests();
/// # fireweave::start::start(fireweave::start::StartOptions {
/// #     mode: Some(fireweave::Mode::Local),
/// #     log: Some(std::sync::Arc::new(|_line: &str| {})),
/// #     ..Default::default()
/// # }).unwrap();
/// if let Err(e) = fireweave::start::identify("user-1", [("plan", "pro")]) {
///     eprintln!("fireweave identify failed: {e}");
/// }
/// // No properties:
/// fireweave::start::identify("user-2", std::iter::empty::<(&str, &str)>()).unwrap();
/// # fireweave::start::reset_for_tests();
/// ```
pub fn identify<I, K, V>(targeting_key: &str, properties: I) -> Result<(), FireweaveError>
where
    I: IntoIterator<Item = (K, V)>,
    K: Into<String>,
    V: Into<JsonValue>,
{
    let outcome = catch_unwind(AssertUnwindSafe(move || {
        if targeting_key.trim().is_empty() {
            return Err(FireweaveError::targeting_key_missing());
        }
        let mut options = RegisterTargetOptions {
            kind: Some(TargetKind::User),
            ..Default::default()
        };
        for (k, v) in properties {
            options
                .properties
                .get_or_insert_with(Default::default)
                .insert(k.into(), v.into());
        }
        let result = client().register_target(targeting_key, Some(&options));
        if result.ok {
            Ok(())
        } else {
            Err(result
                .error
                .unwrap_or_else(|| FireweaveError::new(ErrorKind::Internal)))
        }
    }));
    outcome.unwrap_or_else(|_| Err(FireweaveError::new(ErrorKind::Internal)))
}

/// A stable targeting key for reads where the server itself is the subject
/// (cron, workers, boot-time decisions): `StartOptions::instance_id`, else
/// `FIREWEAVE_INSTANCE_ID`, else `inst_` + a hash of the host name (the same
/// key every FireWeave SDK derives on that host), else a random id for the
/// life of the process (with one warning). Nothing is written to disk. Set
/// `FIREWEAVE_INSTANCE_ID` when replicas share a host name or the host name
/// is not stable. Never injected into contexts: pass it explicitly.
///
/// ```
/// use fireweave::EvaluationContext;
/// let ctx = EvaluationContext::new().with_targeting_key(fireweave::start::instance_key());
/// # let _ = ctx;
/// ```
pub fn instance_key() -> String {
    let (key, lines, log) = {
        let mut st = lock();
        let mut lines = Vec::new();
        if st.instance_key.is_none() {
            let lookup = st.lookup.clone().unwrap_or_else(|| lookup_from(None));
            let (key, source) =
                derive_instance_key(st.instance_option.as_deref(), &*lookup, &process_hostname);
            if source == SOURCE_RANDOM {
                st.warn_once(
                    &mut lines,
                    format!("[fireweave] No host name found, so instance_key() is random for this process. Set {ENV_INSTANCE_ID} for a stable key."),
                );
            }
            st.instance_key = Some(key);
        }
        (
            st.instance_key.clone().unwrap_or_default(),
            lines,
            st.log.clone(),
        )
    };
    emit(log, lines);
    key
}

/// What [`start`] decided. Never contains the key, so it is safe to log.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct Status {
    pub state: StartState,
    /// `None` until a start resolved one.
    pub mode: Option<Mode>,
    /// `"option"`, `"key"` or `"environment"`.
    pub mode_source: Option<String>,
    pub channel: Channel,
    pub sdk_version: String,
    /// The fw-server host name only (remote mode): never a path or a
    /// credential.
    pub host: Option<String>,
    /// Where the endpoint came from: `StartOptions.url`, a variable name, or
    /// `SDK channel (…)` (remote mode).
    pub endpoint_source: Option<String>,
    /// `StartOptions.key` or the variable the key came from; `"none"` in
    /// local mode.
    pub key_source: Option<String>,
    /// The environment name, when it chose the mode.
    pub environment: Option<String>,
    pub flag_count: usize,
    /// Why start failed, when it did. Already redacted.
    pub error: Option<String>,
}

/// Reports the singleton's state and what [`start`] decided: mode and why,
/// channel, SDK version, host, endpoint source, key source, environment and
/// flag count, and the start error if any. It never includes the key.
///
/// ```
/// eprintln!("fireweave: {:?}", fireweave::start::status());
/// ```
pub fn status() -> Status {
    let st = lock();
    let mut s = Status {
        state: st.state,
        mode: None,
        mode_source: None,
        channel: sdk_channel(),
        sdk_version: sdk_version().to_string(),
        host: None,
        endpoint_source: None,
        key_source: None,
        environment: None,
        flag_count: 0,
        error: st.err.as_ref().map(|e| e.message.clone()),
    };
    if let Some(r) = &st.resolved {
        s.mode = Some(r.mode);
        s.mode_source = Some(r.mode_source.to_string());
        s.channel = r.channel;
        s.sdk_version = r.sdk_version.clone();
        s.host = r.host.clone();
        s.endpoint_source = r.url_source.clone();
        s.key_source = Some(r.key_source.clone());
        s.environment = r.environment.clone();
        s.flag_count = r.flags.len();
    }
    s
}

/// Shuts the started client down. Afterwards reads serve their defaults
/// (`AlreadyClosed`) and nothing starts implicitly; a later [`start`] begins
/// fresh. Idempotent. Remote reads hold no buffer, so there is nothing to
/// flush.
pub fn shutdown() {
    let client = {
        let mut st = lock();
        st.state = StartState::Shutdown;
        st.implicit_tried = true;
        st.client.take()
    };
    if let Some(client) = client {
        client.shutdown();
    }
}

/// Test hook: shuts down and forgets the singleton, warnings, instance key
/// and log sink included, so the next start begins as in a new process. The
/// permanent client is kept: it holds no state of its own. Not part of the
/// stable API.
#[doc(hidden)]
pub fn reset_for_tests() {
    let client = {
        let mut st = lock();
        let client = st.client.take();
        *st = Singleton::new();
        client
    };
    if let Some(client) = client {
        client.shutdown();
    }
}
