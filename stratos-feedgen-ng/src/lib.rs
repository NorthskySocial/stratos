//! Fail-closed Feedgen implementation.
//!
//! Exposes discovery and readiness only; it does not serve feeds or persist data.

pub mod config;
pub mod readiness;
pub mod server;
