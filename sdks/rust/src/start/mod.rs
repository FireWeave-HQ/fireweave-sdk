//! The FireWeave **start profile**: one-line setup layered over the
//! unchanged core SDK (`docs/adr/0012-start-profile.md`).
//!
//! The core (everything outside this module) reads no environment and never
//! infers a mode. This module is the documented exception: it reads
//! `FIREWEAVE_*` variables, chooses the mode by a fail-closed rule, defaults
//! the endpoint from this crate build's release channel, and keeps one
//! client per process. It is built only on the crate's public (root
//! re-exported) API and the standard library, and it reads the environment
//! and the host name through one file (`env.rs`); `tests/start_guards.rs`
//! enforces all three.
//!
//! ```
//! use fireweave::start::{define_control_points, LocalControlPoint, LocalControlPoints, StartOptions};
//! use fireweave::EvaluationContext;
//! # fireweave::start::reset_for_tests();
//!
//! // src/fireweave_control_points.rs: every control point the app reads, with its local value
//! pub fn control_points() -> LocalControlPoints {
//!     define_control_points([("new-checkout", LocalControlPoint::local(true))])
//! }
//!
//! // main(), first thing after config loading
//! # let run = || -> Result<(), fireweave::FireweaveError> {
//! fireweave::start::start(StartOptions { control_points: control_points(), ..Default::default() })?;
//! # Ok(()) };
//! # let _ = run;
//! # fireweave::start::start(StartOptions {
//! #     control_points: control_points(),
//! #     mode: Some(fireweave::Mode::Local),
//! #     log: Some(std::sync::Arc::new(|_line: &str| {})),
//! #     ..Default::default()
//! # }).unwrap();
//!
//! // anywhere: the core's nine read methods, unchanged
//! let ctx = EvaluationContext::new().with_targeting_key("user-1");
//! // @fireweave-controlpoint new-checkout
//! let on = fireweave::start::control_points().get_boolean_value("new-checkout", false, Some(&ctx));
//! # assert!(on);
//! # fireweave::start::reset_for_tests();
//! ```
//!
//! Deployed environments set one variable, `FIREWEAVE_KEY` (the project key,
//! `project-api-key_…`). Local development needs nothing when
//! `FIREWEAVE_ENV` or `APP_ENV` is `development`, `dev`, `local` or `test`.
//!
//! # Mode rule
//!
//! `StartOptions::mode` wins. Otherwise a key means remote; no key and a
//! development environment name means local; anything else (including no
//! environment name at all) is a `Configuration` error from [`start`] naming
//! `FIREWEAVE_KEY`, so a deploy that forgot its key fails instead of
//! silently serving defaults.
//!
//! # Reads
//!
//! Reads never panic and never fail: if start failed they serve the
//! caller's default, and the `*_details` forms return an `ERROR`
//! [`crate::Decision`] carrying the start error. A read before any [`start`]
//! starts FireWeave from the environment alone, once, on that read; a later
//! `start` with a different configuration then returns a `Configuration`
//! error saying so. Call `start` first in `main`.
//!
//! In remote mode each read is one blocking request to fw-server with the
//! core's request timeout and no cache, exactly as with
//! [`crate::init_fireweave`]; inside an async executor, read from
//! `spawn_blocking` (or `web::block`).
//!
//! # Debugging
//!
//! [`status`] reports the state, mode and why, channel, SDK version, host,
//! endpoint source, key source, environment and flag count, and the start
//! error if any. It never contains the key.

mod channel;
mod control_points;
mod env;
mod instance;
mod names;
mod options;
mod resolve;
mod state;
mod test_hooks;

pub use channel::{channel_for_version, sdk_channel, sdk_version, Channel};
pub use control_points::{
    define_control_points, try_define_control_points, LocalControlPoint, LocalControlPoints,
};
pub use options::{env_map, EnvFn, LogFn, StartOptions};
#[doc(hidden)]
pub use state::reset_for_tests;
pub use state::{
    client, control_points, identify, instance_key, shutdown, start, status, StartState, Status,
};
#[doc(hidden)]
pub use test_hooks::{derive_instance_key_for_tests, resolve_for_tests, ResolvedForTests};
