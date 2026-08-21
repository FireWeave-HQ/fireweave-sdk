//! Concrete `BackendAdapter` implementations: local (dev), in-memory
//! (fixtures/tests), and remote (fw-server over HTTP).

pub mod local;
pub mod memory;
pub mod remote;
