//! Infrastructure layer: adapters and the SSRF host allowlist. May import
//! `application::` (the port trait, records) and `domain::`, never the
//! reverse.

pub mod adapters;
pub mod hosts;
