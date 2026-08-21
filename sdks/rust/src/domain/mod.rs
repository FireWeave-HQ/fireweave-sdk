//! Domain layer: pure types and validators. Imports nothing from
//! `application::` or `infrastructure::` (guard-enforced,
//! `tests/architecture_guard.rs`).

pub mod context;
pub mod decision;
pub mod errors;
pub mod mode;
pub mod target;
pub mod types;
pub mod validation;
