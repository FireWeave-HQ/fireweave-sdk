//! Application layer: runtime, client, ports, and the `mode` composition
//! root. Outside `mode.rs`, this layer imports nothing from
//! `infrastructure::` (guard-enforced, `tests/architecture_guard.rs`).

pub mod client;
pub mod mode;
pub mod ports;
pub mod runtime;
