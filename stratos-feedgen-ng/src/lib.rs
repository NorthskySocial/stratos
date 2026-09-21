//! Fail-closed Feedgen implementation.
//!
//! Exposes discovery and readiness only; it does not serve feeds or persist data.

pub mod admission;
pub mod config;
pub mod conformance;
pub mod cursor;
pub mod feeds;
pub mod identifier;
pub mod readiness;
pub mod runtime;
pub mod server;
pub mod service;
pub mod store;
